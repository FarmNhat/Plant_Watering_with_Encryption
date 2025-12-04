// MQTT Configuration
export const mqttConfig = {
  brokerUrl: process.env.MQTT_BROKER_URL || 'mqtt://broker.hivemq.com:1883',
  topics: {
    data: process.env.MQTT_TOPIC_DATA || 'device/sensor/data',
    command: process.env.MQTT_TOPIC_COMMAND || 'device/command'
  },
  options: {
    clientId: 'smart-watering-server',
    clean: true,
    connectTimeout: 4000,
    reconnectPeriod: 1000,
  }
};

