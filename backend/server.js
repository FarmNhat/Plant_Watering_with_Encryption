import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import mqtt from 'mqtt';
import { createServer } from 'http';
import { Server } from 'socket.io';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import { mqttConfig } from './config.js';

// Get current directory for relative paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3001;

// Create HTTP server and Socket.IO instance
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*", // Allow all origins in development
    methods: ["GET", "POST"]
  }
});

// MQTT client
let mqttClient = null;

// Middleware
app.use(cors());
app.use(express.json());

// In-memory storage for sensor data (will be updated via MQTT)
let sensorData = {
  temp: 24,
  hum: 66,
  soil: 60,
  level: 56,
  flow: 0,
  timestamp: Date.now()
};

// System state
let systemState = {
  pumpOn: false,
  mode: 'automatic', // 'automatic' or 'manual'
  pumpStartTime: null,
  pumpDuration: 0, // in milliseconds
  lastCommand: null,
  lastCommandTime: null,
  aiEnabled: process.env.AI_ENABLED !== 'false', // Enable AI by default
  lastAIDecision: null,
  lastAIReason: null
};

// Get AI decision based on sensor data
async function getAIDecision(temp, humid, soil) {
  try {
    if (!systemState.aiEnabled) {
      return null;
    }

    const aiServicePath = path.join(__dirname, 'AI_service.py');
    
    // Call Python AI service with sensor data
    const { stdout, stderr } = await execFileAsync('python', [
      aiServicePath,
      temp.toString(),
      humid.toString(),
      soil.toString()
    ], { 
      timeout: 5000,
      env: process.env 
    });

    const result = JSON.parse(stdout);
    
    // Store last AI decision
    systemState.lastAIDecision = result.action;
    systemState.lastAIReason = result.reason || 'AI Model Decision';
    
    console.log('AI Decision:', result);
    return result;
  } catch (error) {
    console.error('AI Service Error:', error.message);
    return null;
  }
}

// Basic health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Smart Watering Backend is running' });
});

// Get current sensor data
app.get('/api/sensors', (req, res) => {
  res.json(sensorData);
});

// Get system status (pump state, mode, ...)
app.get('/api/status', (req, res) => {
  res.json({
    pumpOn: systemState.pumpOn,
    mode: systemState.mode,
    pumpStartTime: systemState.pumpStartTime,
    pumpDuration: systemState.pumpDuration,
    remainingTime: systemState.pumpOn && systemState.pumpStartTime
      ? Math.max(0, systemState.pumpDuration - (Date.now() - systemState.pumpStartTime))
      : 0,
    lastCommand: systemState.lastCommand,
    lastCommandTime: systemState.lastCommandTime,
    aiEnabled: systemState.aiEnabled,
    lastAIDecision: systemState.lastAIDecision,
    lastAIReason: systemState.lastAIReason
  });
});

// Get current mode
app.get('/api/mode', (req, res) => {
  res.json({ mode: systemState.mode });
});

// Get AI status
app.get('/api/ai/status', (req, res) => {
  res.json({
    aiEnabled: systemState.aiEnabled,
    lastDecision: systemState.lastAIDecision,
    lastReason: systemState.lastAIReason
  });
});

// Enable/Disable AI
app.post('/api/ai/toggle', (req, res) => {
  const { enabled } = req.body;
  
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ 
      error: 'Invalid parameter. "enabled" must be a boolean' 
    });
  }
  
  systemState.aiEnabled = enabled;
  console.log(`AI ${enabled ? 'enabled' : 'disabled'}`);
  
  io.emit('ai_status_update', {
    aiEnabled: systemState.aiEnabled
  });
  
  res.json({
    success: true,
    aiEnabled: systemState.aiEnabled,
    message: `AI ${enabled ? 'enabled' : 'disabled'}`
  });
});

// Get AI decision for current sensor data
app.get('/api/ai/decide', async (req, res) => {
  try {
    const decision = await getAIDecision(sensorData.temp, sensorData.hum, sensorData.soil);
    
    if (!decision) {
      return res.status(500).json({
        error: 'Failed to get AI decision',
        aiEnabled: systemState.aiEnabled
      });
    }
    
    res.json(decision);
  } catch (error) {
    res.status(500).json({
      error: 'Error getting AI decision: ' + error.message
    });
  }
});

// Set mode (automatic or manual)
app.post('/api/mode', (req, res) => {
  const { mode } = req.body;
  
  if (!mode || !['automatic', 'manual'].includes(mode)) {
    return res.status(400).json({ 
      error: 'Invalid mode. Must be "automatic" or "manual"' 
    });
  }
  
  systemState.mode = mode;
  console.log(`Mode changed to: ${mode}`);
  
  // Send mode command to device via MQTT
  publishCommand('set_mode', { mode: mode });
  
  // Emit mode change to all connected clients
  io.emit('mode_update', { mode: systemState.mode });
  
  res.json({ 
    success: true, 
    mode: systemState.mode,
    message: `Mode set to ${mode}` 
  });
});

// Start pump
app.post('/api/pump/start', (req, res) => {
  const { duration } = req.body; // duration in seconds 
  
  if (systemState.pumpOn) {
    return res.status(400).json({ 
      error: 'Pump is already running',
      currentState: systemState 
    });
  }
  
  // Default duration
  const durationMs = (duration || 10) * 1000; // 10 seconds default
  
  systemState.pumpOn = true;
  systemState.pumpStartTime = Date.now();
  systemState.pumpDuration = durationMs;
  systemState.lastCommand = 'start';
  systemState.lastCommandTime = Date.now();
  
  console.log(`Pump started. Duration: ${durationMs}ms`);
  
  // Send pump start command to device via MQTT
  publishCommand('pump_start', { 
    duration: duration, // duration in seconds
    durationMs: durationMs,
    mode: systemState.mode 
  });
  
  // Emit pump state update to all connected clients
  emitSystemState();
  
  res.json({ 
    success: true, 
    message: 'Pump started',
    duration: durationMs,
    mode: systemState.mode
  });
  
  // Auto-stop after duration )
  if (systemState.mode === 'automatic') {
    setTimeout(() => {
      if (systemState.pumpOn) {
        systemState.pumpOn = false;
        systemState.pumpStartTime = null;
        systemState.pumpDuration = 0;
        systemState.lastCommand = 'auto_stop';
        systemState.lastCommandTime = Date.now();
        console.log('Pump auto-stopped after duration');
        
        // Send auto-stop command to device via MQTT
        publishCommand('pump_stop', { reason: 'auto_stop' });
        
        // Emit pump state update to all connected clients
        emitSystemState();
      }
    }, durationMs);
  }
});

// Stop pump
app.post('/api/pump/stop', (req, res) => {
  if (!systemState.pumpOn) {
    return res.status(400).json({ 
      error: 'Pump is not running',
      currentState: systemState 
    });
  }
  
  const runTime = systemState.pumpStartTime 
    ? Date.now() - systemState.pumpStartTime 
    : 0;
  
  systemState.pumpOn = false;
  systemState.pumpStartTime = null;
  systemState.pumpDuration = 0;
  systemState.lastCommand = 'stop';
  systemState.lastCommandTime = Date.now();
  
  console.log(`Pump stopped. Was running for ${runTime}ms`);
  
  // Send pump stop command to device via MQTT
  publishCommand('pump_stop', { runTime: runTime });
  
  // Emit pump state update to all connected clients
  emitSystemState();
  
  res.json({ 
    success: true, 
    message: 'Pump stopped',
    runTime: runTime
  });
});

// Emit system state to all connected WebSocket clients
function emitSystemState() {
  const status = {
    pumpOn: systemState.pumpOn,
    mode: systemState.mode,
    pumpStartTime: systemState.pumpStartTime,
    pumpDuration: systemState.pumpDuration,
    remainingTime: systemState.pumpOn && systemState.pumpStartTime
      ? Math.max(0, systemState.pumpDuration - (Date.now() - systemState.pumpStartTime))
      : 0,
    lastCommand: systemState.lastCommand,
    lastCommandTime: systemState.lastCommandTime,
    aiEnabled: systemState.aiEnabled,
    lastAIDecision: systemState.lastAIDecision,
    lastAIReason: systemState.lastAIReason
  };
  
  io.emit('status_update', status);
}

// Publish command to device via MQTT with binary format and SHA256 hash
function publishCommand(command, data = {}) {
  if (!mqttClient || !mqttClient.connected) {
    console.error('MQTT client not connected. Cannot send command:', command);
    return false;
  }

  // Parse command and create binary packet
  let pump_control = 0;
  let duration = 0;
  let mode = 0;

  if (command === 'pump_start') {
    pump_control = 1;
    duration = data.duration || 10; // duration in seconds
    mode = systemState.mode === 'automatic' ? 1 : 0;
  } else if (command === 'pump_stop') {
    pump_control = 0;
    duration = data.duration || 0;
    mode = systemState.mode === 'automatic' ? 1 : 0;
  } else if (command === 'set_mode') {
    pump_control = 2; // mode command
    duration = 0;
    mode = data.mode === 'automatic' ? 1 : 0;
  }

  // Create 6-byte binary packet: pump_control(1) + duration(4) + mode(1)
  const packet = Buffer.alloc(6);
  packet[0] = pump_control;
  packet.writeUInt32BE(duration, 1);
  packet[5] = mode;

  // Calculate SHA256 hash of the 6-byte packet
  const hash = crypto.createHash('sha256').update(packet).digest();

  // Combine packet + hash (6 + 32 = 38 bytes)
  const message = Buffer.concat([packet, hash]);

  const topic = mqttConfig.topics.command;

  mqttClient.publish(topic, message, { qos: 1 }, (err) => {
    if (err) {
      console.error(`Failed to publish command "${command}":`, err.message);
    } else {
      console.log(`Command published to ${topic}:`, {
        command,
        pump_control,
        duration,
        mode,
        packetHex: packet.toString('hex'),
        hashHex: hash.toString('hex'),
        messageSize: message.length
      });
    }
  });

  return true;
}

// Connect to MQTT broker
function connectMQTT() {
  try {
    console.log(`Connecting to MQTT broker: ${mqttConfig.brokerUrl}`);
    mqttClient = mqtt.connect(mqttConfig.brokerUrl, mqttConfig.options);

    mqttClient.on('connect', () => {
      console.log('Connected to MQTT broker');
      console.log(`Subscribing to topic: ${mqttConfig.topics.data}`);
      
      // Subscribe to device data topic
      mqttClient.subscribe(mqttConfig.topics.data, (err) => {
        if (err) {
          console.error('Failed to subscribe:', err.message);
        } else {
          console.log(`Successfully subscribed to ${mqttConfig.topics.data}`);
        }
      });
    });

    mqttClient.on('error', (error) => {
      console.error('MQTT connection error:', error.message);
    });

    mqttClient.on('close', () => {
      console.log('MQTT connection closed');
    });

    mqttClient.on('reconnect', () => {
      console.log('Reconnecting to MQTT broker...');
    });

    // Handle incoming messages from device
    mqttClient.on('message', (topic, message) => {
      if (topic === mqttConfig.topics.data) {
        try {
          // Parse JSON message from device
          const data = JSON.parse(message.toString());
          console.log('Received sensor data:', data);
          
          // Update sensor data with timestamp
          sensorData = {
            temp: data.temp || data.temperature || sensorData.temp,
            hum: data.hum || data.humidity || sensorData.hum,
            soil: data.soil || data.soilMoisture || sensorData.soil,
            level: data.level || data.waterLevel || data.water_ml || sensorData.level,
            rain: data.rain || sensorData.rain || 0,
            flow: data.flow || data.flowRate || sensorData.flow,
            timestamp: Date.now()
          };
          
          console.log('Sensor data updated:', sensorData);
          
          // Emit sensor data update to all connected clients
          io.emit('sensor_update', sensorData);
          
          // If in automatic mode and AI is enabled, get AI decision
          if (systemState.mode === 'automatic' && systemState.aiEnabled && !systemState.pumpOn) {
            getAIDecision(sensorData.temp, sensorData.hum, sensorData.soil)
              .then(decision => {
                if (decision && decision.action === 1) {
                  console.log('AI Decision: Start pump');
                  // Start pump automatically based on AI decision
                  const durationMs = 10 * 1000; // 10 seconds default
                  systemState.pumpOn = true;
                  systemState.pumpStartTime = Date.now();
                  systemState.pumpDuration = durationMs;
                  systemState.lastCommand = 'ai_start';
                  systemState.lastCommandTime = Date.now();
                  
                  publishCommand('pump_start', { 
                    duration: 10,
                    durationMs: durationMs,
                    mode: systemState.mode 
                  });
                  
                  emitSystemState();
                  
                  // Auto-stop after duration
                  setTimeout(() => {
                    if (systemState.pumpOn) {
                      systemState.pumpOn = false;
                      systemState.pumpStartTime = null;
                      systemState.pumpDuration = 0;
                      systemState.lastCommand = 'auto_stop';
                      systemState.lastCommandTime = Date.now();
                      console.log('Pump auto-stopped after duration');
                      
                      publishCommand('pump_stop', { reason: 'auto_stop' });
                      emitSystemState();
                    }
                  }, durationMs);
                }
              })
              .catch(err => console.error('Error in AI decision:', err));
          }
        } catch (error) {
          console.error('Failed to parse MQTT message:', error.message);
          console.error('Raw message:', message.toString());
        }
      }
    });
  } catch (error) {
    console.error('Failed to initialize MQTT client:', error.message);
  }
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
  
  // Send current state to newly connected client
  socket.emit('sensor_update', sensorData);
  emitSystemState();
  
  // Handle client disconnection
  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
  
  // Optional: Handle client requests for current data
  socket.on('get_sensors', () => {
    socket.emit('sensor_update', sensorData);
  });
  
  socket.on('get_status', () => {
    emitSystemState();
  });
});

// Start server
httpServer.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
  console.log(`WebSocket server ready on ws://localhost:${PORT}`);
  console.log(`Ready to receive MQTT messages...`);
  
  // Connect to MQTT broker
  connectMQTT();
});

