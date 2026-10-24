#include <Arduino.h>

constexpr uint8_t LED_PIN = LED_BUILTIN;
constexpr unsigned long INTERVAL_MS = 1000;
unsigned long previousMillis = 0;
bool ledOn = false;

void setup() {
    pinMode(LED_PIN, OUTPUT);
    digitalWrite(LED_PIN, LOW);
    Serial.begin(115200);
    Serial.println("Openplatform IDE: Arduino built-in LED blink ready");
}

void loop() {
    const unsigned long now = millis();
    if (now - previousMillis >= INTERVAL_MS) {
        previousMillis = now;
        ledOn = !ledOn;
        digitalWrite(LED_PIN, ledOn ? HIGH : LOW);
        Serial.println(ledOn ? "LED: on" : "LED: off");
    }
}
