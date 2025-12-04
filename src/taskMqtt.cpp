#include "taskMqtt.h"
#include <WiFi.h>
#include <ArduinoJson.h>
#include <PubSubClient.h> // MQTT library
#include "pump_control.h"
#include "global.h"
#include "mbedtls/sha256.h"

//#define ENCRYPTION
#define NON_ENCRYPTION

static const char *MQTT_SERVER = "broker.hivemq.com";
static const uint16_t MQTT_PORT = 1883;

// Topic cho Pub/Sub
static const char *TOPIC_SENSOR = "device/sensor/data";
static const char *TOPIC_CMD = "device/command";

// Client MQTT
static WiFiClient s_espClient;                 // TCP Client
static PubSubClient s_mqttClient(s_espClient); // vừa pub vừa sub

//Callback khi nhận payload message MQTT (SUB)
static void mqttCallback(char *topic, uint8_t *payload, unsigned int len)
{
    // Copy payload sang 1 buffer có null-terminator để in cho dễ
    Serial.println("=== BINARY COMMAND RECEIVED ===");

    if (len < 38) {
        Serial.println("ERROR: packet too small");
        return;
    }
    int pump_control;
    uint32_t duration;
    uint8_t mode;
    pump_control  = payload[0];
    duration = *(uint32_t*)(payload + 1);
    mode    = payload[5];


    uint8_t hash_recv[32];
    memcpy(hash_recv, payload + 6, 32);

    // === Recompute SHA256 ===
    uint8_t check_input[6];
    memcpy(check_input, payload, 6);

    uint8_t hash_calc[32];
    mbedtls_sha256_context ctx;
    mbedtls_sha256_init(&ctx);
    mbedtls_sha256_starts_ret(&ctx, 0);
    mbedtls_sha256_update_ret(&ctx, check_input, 6);
    mbedtls_sha256_finish_ret(&ctx, hash_calc);

    if (memcmp(hash_calc, hash_recv, 32) != 0) {
        Serial.println("HASH FAILED !!!");
        return;}

    if (pump_control == 1) {
        pump_start(duration*1000, mode);
    } else if (pump_control == 0) {
        pump_stop(duration);
    } 
    pump_set_mode(mode);

}


 // ============== SHA256 ================

 uint8_t output52[52];

void sha2(float temp, float hum, float soid, float total_ml, float rain){
  uint8_t input[20];

    memcpy(input + 0, &temp, 4);
    memcpy(input + 4, &hum, 4);
    memcpy(input + 8, &soid, 4);
    memcpy(input + 12, &total_ml, 4);
    memcpy(input + 16, &rain, 4);

  uint8_t out32[32];

  mbedtls_sha256_context ctx;
  mbedtls_sha256_init(&ctx);
  mbedtls_sha256_starts_ret(&ctx, 0);
  mbedtls_sha256_update_ret(&ctx, input, 20);
  mbedtls_sha256_finish_ret(&ctx, out32);

  memcpy(output52, input, 20);
  memcpy(output52 + 20, out32, 32);
}

#ifdef ENCRYPTION

static void mqttCallback(char *topic, uint8_t *payload, unsigned int length)
{
    // 1. Copy payload sang buffer có null-terminator
    char buf[256];
    unsigned int n = (length < sizeof(buf) - 1) ? length : sizeof(buf) - 1;
    memcpy(buf, payload, n);
    buf[n] = '\0';

    // 2. In ra Serial (có mutex)
    if (xSerialMutex != NULL &&
        xSemaphoreTake(xSerialMutex, portMAX_DELAY) == pdPASS)
    {
        Serial.print("[MQTT] Message arrived on topic: ");
        Serial.println(topic);
        Serial.print("Payload: ");
        Serial.println(buf);
        xSemaphoreGive(xSerialMutex);
    }

    // 3. Parse JSON bằng ArduinoJson
    StaticJsonDocument<256> doc; // ESP32 đủ RAM cho size này

    DeserializationError err = deserializeJson(doc, buf);
    if (err)
    {
        if (xSerialMutex != NULL &&
            xSemaphoreTake(xSerialMutex, portMAX_DELAY) == pdPASS)
        {
            Serial.print("[MQTT] JSON parse failed: ");
            Serial.println(err.c_str());
            xSemaphoreGive(xSerialMutex);
        }
        return;
    }

    // 4. Đọc field "command"
    const char *cmd = doc["command"] | "";
    if (cmd[0] == '\0')
    {
        if (xSerialMutex != NULL &&
            xSemaphoreTake(xSerialMutex, portMAX_DELAY) == pdPASS)
        {
            Serial.println("[MQTT] Missing 'command' field");
            xSemaphoreGive(xSerialMutex);
        }
        return;
    }

    // 5. Đọc thêm timestamp (nếu có)
    uint32_t timestamp = doc["timestamp"] | 0;

    // 6. Xử lý theo từng loại command

    // ---- pump_start ----
    if (strcmp(cmd, "pump_start") == 0)
    {
        // {"command":"pump_start","timestamp":..., "duration":10,"durationMs":10000,"mode":"manual"}

        uint32_t duration = doc["duration"] | 0;     // giây
        uint32_t durationMs = doc["durationMs"] | 0; // ms
        const char *modeStr = doc["mode"] | "manual";

        if (durationMs == 0 && duration > 0)
        {
            durationMs = duration * 1000; // fallback: từ giây -> ms
        }

        uint8_t mode = (strcmp(modeStr, "automatic") == 0) ? 1 : 0;

        if (xSerialMutex != NULL &&
            xSemaphoreTake(xSerialMutex, portMAX_DELAY) == pdPASS)
        {
            Serial.println("[MQTT] Command: pump_start");
            Serial.print("  timestamp = ");
            Serial.println(timestamp);
            Serial.print("  durationMs = ");
            Serial.println(durationMs);
            Serial.print("  mode = ");
            Serial.println(modeStr);
            xSemaphoreGive(xSerialMutex);
        }

        pump_start(durationMs, mode);
    }
    // ---- pump_stop ----
    else if (strcmp(cmd, "pump_stop") == 0)
    {
        // {"command":"pump_stop","timestamp":..., "runTime":5000}

        uint32_t runTime = doc["runTime"] | 0;

        if (xSerialMutex != NULL &&
            xSemaphoreTake(xSerialMutex, portMAX_DELAY) == pdPASS)
        {
            Serial.println("[MQTT] Command: pump_stop");
            Serial.print("  timestamp = ");
            Serial.println(timestamp);
            Serial.print("  runTime   = ");
            Serial.println(runTime);
            xSemaphoreGive(xSerialMutex);
        }

        pump_stop(runTime);
    }
    // ---- set_mode ----
    else if (strcmp(cmd, "set_mode") == 0)
    {
        // {"command":"set_mode","timestamp":..., "mode":"automatic"}

        const char *modeStr = doc["mode"] | "";
        
        uint8_t mode = (strcmp(modeStr, "automatic") == 0) ? 1 : 0;

        if (xSerialMutex != NULL &&
            xSemaphoreTake(xSerialMutex, portMAX_DELAY) == pdPASS)
        {
            Serial.println("[MQTT] Command: set_mode");
            Serial.print("  timestamp = ");
            Serial.println(timestamp);
            Serial.print("  mode      = ");
            Serial.println(modeStr);
            xSemaphoreGive(xSerialMutex);
        }

        pump_set_mode(mode);
    }
    else
    {
        // Command lạ
        if (xSerialMutex != NULL &&
            xSemaphoreTake(xSerialMutex, portMAX_DELAY) == pdPASS)
        {
            Serial.print("[MQTT] Unknown command: ");
            Serial.println(cmd);
            xSemaphoreGive(xSerialMutex);
        }
    }
}
#endif

void MQTT_Connect()
{
    s_mqttClient.setServer(MQTT_SERVER, MQTT_PORT); // chỉ định broker: broker.hivemq.com:1883
    s_mqttClient.setCallback(mqttCallback);

    uint32_t t0 = millis();
    while (!s_mqttClient.connected() && millis() - t0 < 5000)
    {
        String clientID = "ESP32-" + String(random(0xffff), HEX);
        Serial.print("[MQTT] Connecting...");

        if (s_mqttClient.connect(clientID.c_str()))
        {
            Serial.println("OK");
            // Subribe topic
            s_mqttClient.subscribe(TOPIC_CMD);
        }
        else
        {
            Serial.print("Failed, reconnecting....");
            Serial.print(s_mqttClient.state());
            Serial.println(" try again...");
            vTaskDelay(pdMS_TO_TICKS(1000));
        }
    }

    if (!s_mqttClient.connected())
    {
        Serial.println("[MQTT] Connect timeout, retry later !!!");
    }
}

void task_MQTT(void *pvParameter)
{
    pump_init();
    glob_pump_running = false;

    TickType_t lastWake = xTaskGetTickCount();

    while (1)
    {
        // 1. Chờ WiFI
        if (WiFi.status() != WL_CONNECTED)
        {
            if (xSerialMutex != NULL &&
                xSemaphoreTake(xSerialMutex, portMAX_DELAY) == pdPASS)
            {
                Serial.println("[MQTT] Waiting for WiFi...");
                xSemaphoreGive(xSerialMutex);
            }

            vTaskDelay(pdMS_TO_TICKS(2000));
            continue;
        }

        // 2. Đảm bảo MQTT đã kết nối
        if (!s_mqttClient.connected())
        {
            if (xSerialMutex != NULL &&
                xSemaphoreTake(xSerialMutex, portMAX_DELAY) == pdPASS)
            {
                MQTT_Connect();
                xSemaphoreGive(xSerialMutex);
            }
        }

        // 3. Nếu đã kết nối -> gọi loop xử lý gói đến
        if (s_mqttClient.connected())
        {
            s_mqttClient.loop();
        }

        // 4. Read sensor
        float temp, hum, soil, rain, total_ml;

        if (xSensorMutex != NULL &&
            xSemaphoreTake(xSensorMutex, portMAX_DELAY) == pdPASS)
        {
            temp = glob_temp;
            hum = glob_humid;
            soil = glob_soil;
            rain = glob_rain;
            total_ml = glob_total_ml;
            xSemaphoreGive(xSensorMutex);
        }

        // 5. Sanitize NaN values
        if (isnan(temp)) temp = 0.0;
        if (isnan(hum)) hum = 0.0;
        if (isnan(soil)) soil = 0.0;
        if (isnan(rain)) rain = 0.0;
        if (isnan(total_ml)) total_ml = 0.0;

        sha2(temp, hum, soil, total_ml, rain);

        // 6. Format payload - use ArduinoJson for safer serialization
        StaticJsonDocument<256> sensorDoc;
        sensorDoc["temp"] = serialized(String(temp, 2));
        sensorDoc["hum"] = serialized(String(hum, 2));
        sensorDoc["soil"] = serialized(String(soil, 2));
        sensorDoc["rain"] = serialized(String(rain, 2));
        sensorDoc["water_ml"] = serialized(String(total_ml, 2));

        char payload[256];
        serializeJson(sensorDoc, payload, sizeof(payload));

        if (s_mqttClient.connected()){
            s_mqttClient.publish(TOPIC_SENSOR, payload);
            if (xSerialMutex != NULL &&
                xSemaphoreTake(xSerialMutex, portMAX_DELAY) == pdPASS)
            {
                Serial.print("Published: ");
                Serial.println(payload);
                xSemaphoreGive(xSerialMutex);
            }
        }
        
        vTaskDelayUntil(&lastWake, pdMS_TO_TICKS(5000));
    }
}