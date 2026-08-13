/**
 * @file main.c
 * @brief posthog-bell-counter-c6 — servo bell striker + MAX7219 count panel.
 *
 * Derived from the verified ESP32-C6 bench demo, with the startup animation
 * removed. That demo swept the horn 90 -> 45 -> 135 -> 90 and stepped the panel
 * through the angles to prove both drivers worked. This firmware is the real
 * thing, and a real thing that flails on power-up is a liability: a mid-demo
 * brownout would ring the bell on its own and repaint the panel with a number
 * nobody queried.
 *
 * So startup does exactly two things:
 *
 *   1. Parks cleanly. `display_register()` and `servo_register()` each call
 *      their own `*_init()`, which blanks the panel and drives the horn to
 *      `home_angle` (the bell's rest position) before idle-detaching. All this
 *      code adds is a "----" placeholder, so an unpainted panel reads as
 *      "waiting for the first count" rather than as dead hardware.
 *   2. Stays commandable. Both drivers remain registered, so `servo.rotate`
 *      and `display.set` work over MQTT and MCP for as long as the board is up.
 *
 * Everything visible after that is the service's doing.
 *
 * @note Requires the MAX7219 chain-order fix in the SDK's display driver.
 *       Without it the panel renders module-reversed — "90" shows as "09".
 *       See firmware/README.md and firmware/display-module-order.patch.
 */

#include <stdio.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"

#include "jettyd.h"
#include "jettyd_driver.h"
#include "device_config.h"

static const char *TAG = "bell";

#define DISPLAY_INSTANCE "display"
#define SERVO_INSTANCE   "servo"

/* Shown until the first display.set arrives.
 *
 * Sent as a JSON *string*, which is the driver's documented contract:
 * drivers/display/display.c takes `{"value": <string|number>}` and branches on
 * the first non-space character after `"value":` — a quote takes the string
 * path (truncated at 5 chars), a digit or '-' takes the numeric path. So
 * "----" is accepted directly and rendered literally.
 *
 * The numeric spelling `{"value":-1}` reaches the same four dashes by way of
 * compact_number()'s negative branch, but only as a side effect of a rule about
 * out-of-range counts. This panel is showing "no reading yet", not "minus one",
 * so it says so directly rather than relying on that coincidence. */
#define IDLE_PLACEHOLDER "----"

/**
 * Paint the idle placeholder. Failure is logged, not fatal: a blank panel is a
 * cosmetic problem, and the bell is the part that has to work.
 */
static void show_idle_placeholder(void)
{
    const jettyd_driver_t *display = jettyd_driver_find(DISPLAY_INSTANCE);
    if (display == NULL || display->command == NULL) {
        ESP_LOGW(TAG, "display driver not registered — panel stays blank");
        return;
    }

    esp_err_t err = display->command("set", "{\"value\":\"" IDLE_PLACEHOLDER "\"}");
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "idle placeholder failed: %s", esp_err_to_name(err));
    }
}

/**
 * Confirm the servo is registered and parked. servo_init() has already driven
 * the horn to home_angle; this only reports it, so the boot log says whether
 * the bell is at rest without the horn moving again to prove it.
 */
static void report_servo_parked(void)
{
    const jettyd_driver_t *servo = jettyd_driver_find(SERVO_INSTANCE);
    if (servo == NULL) {
        ESP_LOGE(TAG, "servo driver not registered — the bell cannot be rung");
        return;
    }
    ESP_LOGI(TAG, "servo parked at home_angle, awaiting servo.rotate");
}

void app_main(void)
{
    jettyd_config_t config = {
        /* Identity — from device.yaml */
        .device_type      = DEVICE_NAME,
        .firmware_version = DEVICE_VERSION,

        /* Telemetry — from device.yaml defaults */
        .heartbeat_interval_sec = DEVICE_HEARTBEAT_INTERVAL_SEC,
        .default_metrics        = DEVICE_REPORT_METRICS,

        /* MQTT — from device.yaml mqtt: block */
        .mqtt_keepalive            = DEVICE_MQTT_KEEPALIVE,
        .mqtt_qos                  = DEVICE_MQTT_QOS,
        .mqtt_buffer_on_disconnect = true,
        .mqtt_max_buffer_size      = 20,

        /* Power / hardware — from device.yaml */
        .deep_sleep         = false,
        .sleep_duration_sec = 0,
        .has_battery        = false,
        .battery_adc_pin    = -1,
        .battery_voltage_divider = 1.0f,
        .status_led_pin     = -1,
        .wake_on_pin        = -1,
    };

    ESP_ERROR_CHECK(jettyd_init(&config));

    /* Registers *and* initialises both drivers: the panel is blanked and the
     * horn is driven to home_angle here, before any network exists. */
    jettyd_register_drivers();

    show_idle_placeholder();
    report_servo_parked();
    ESP_LOGI(TAG, "startup complete — parked and commandable");

    esp_err_t err = jettyd_start();

    /* jettyd_start() only returns on failure, typically an unreachable WiFi
     * network. Idle rather than abort: the drivers are initialised and still
     * accept local commands, whereas ESP_ERROR_CHECK here would panic into a
     * reboot loop — and a reboot loop on a bell rig is a bell that rings every
     * few seconds until someone pulls the power. */
    ESP_LOGW(TAG, "jettyd_start() returned %s — drivers stay available, idling",
             esp_err_to_name(err));

    while (1) {
        vTaskDelay(pdMS_TO_TICKS(10000));
    }
}
