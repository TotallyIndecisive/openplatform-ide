#include <Arduino.h>

constexpr uint8_t LED_PIN = 23;
constexpr unsigned long INTERVAL_MS = 500;
unsigned long previousMillis = 0;
bool ledOn = false;

void setup() {
    pinMode(LED_PIN, OUTPUT);
    digitalWrite(LED_PIN, LOW);
    Serial.begin(115200);
    Serial.println("Openplatform IDE: ESP32 GPIO 23 blink ready");
}

void loop() {
    const unsigned long now = millis();
    if (now - previousMillis >= INTERVAL_MS) {
        previousMillis = now;
        ledOn = !ledOn;
        digitalWrite(LED_PIN, ledOn ? HIGH : LOW);
        Serial.println(ledOn ? "GPIO 23: on" : "GPIO 23: off");
    }
}
