# Firmware — `posthog-bell-counter-c6`

The device side of the demo: one ESP32-C6 running the Jettyd firmware SDK with
two drivers registered — a hobby servo that strikes the bell and a 4-module
MAX7219 LED panel that shows the count.

| File | What it is |
|---|---|
| `device.yaml` | Device definition — driver instances, pins, servo home angle, MQTT settings |
| `main.c` | Application entry point — parks cleanly, then stays commandable |
| `display-module-order.patch` | **Required** SDK fix, see below |

Both files drop into a checkout of
[`jettyd-firmware-template`](https://github.com/jettydiot/jettyd-firmware-template):
`device.yaml` at the project root, `main.c` in `main/`.

## ⚠️ Required SDK fix: MAX7219 module order

**Without this patch the panel renders right-to-left: `90` shows as `09`, `135`
comes out jumbled.** Each glyph is upright and correctly formed, which is what
makes it confusing — it looks like a font bug, not a chain-order bug.

**Why.** In a MAX7219 daisy chain, the bytes clocked out *first* are shifted the
*furthest* — through every nearer chip and into the last one. On an FC16-style
panel the leftmost module is the last chip in the chain, so it must receive the
first byte pair. `max7219_refresh()` in `drivers/display/display.c` iterated the
modules in reverse, landing the leftmost frame-buffer byte in the chip nearest
the MCU. The result is a panel mirrored by module, with the pixels inside each
module untouched. The driver's own header comment already said "Module 0 =
leftmost visual position (last in SPI chain from MCU)" — the loop contradicted
it.

**Status.** As of 2026-08-13 the fix is **not yet upstream**:
`jettydiot/jettyd-firmware` `main` (`95ea4c2`) still ships the reversed loop, so
a fresh `make setup` clone reproduces the bug. Apply the patch until it lands.

```bash
cd jettyd-sdk                          # the SDK checkout created by `make setup`
git apply ../firmware/display-module-order.patch
grep -n 'for (int m = 0; m < (int)mods; m++)' drivers/display/display.c   # expect one hit
```

The change is one loop direction plus a corrected comment. Nothing else moves:
`display_render()`, the font table, the `bit_pos = 7 - (display_x % 8)` column
mapping and the row/digit-register mapping are all untouched, and
`max7219_write_reg()` needs no change because it sends the same byte to every
chip.

**Verifying it.** The ordering lives in the SPI byte stream, not in the frame
buffer (`s_fb` is always left-to-right), so a frame-buffer assertion cannot see
this bug. The SDK's host suite covers it with a wire sniffer that samples DIN on
each CLK rising edge and closes a frame on the CS latch:

```bash
cd jettyd-sdk/test && make test        # expect all suites green
```

Those tests fail against the unpatched driver and pass against the patched one.
Note that `make test` has bitten people here: `build/test_display` did not list
`../drivers/display/display.c` as a prerequisite even though the test
`#include`s it, so a driver-only edit could leave a stale binary reporting the
*old* result. If a run's result does not match the edit you just made, delete
`test/build/` and re-run before believing it.

**Scope.** The driver is shared, so this also changes `devices/display-demo-v1`
on any board with a same-wired FC16 panel. That is intended — the old order was
wrong for this hardware, not just for this device.

## Wiring

| Signal | GPIO | Notes |
|---|---|---|
| MAX7219 `DIN` | 10 | |
| MAX7219 `CLK` | 8 | |
| MAX7219 `CS` / `LOAD` | 9 | |
| MAX7219 `VCC` | 5 V | Not 3V3 — the panel is dim and unreliable at 3V3 |
| MAX7219 `GND` | GND | |
| Servo signal | 3 | |
| Servo `V+` | 5 V | **External supply.** A bell striker stalls at the end of its swing; that current spike will brown out the board if it comes off USB |
| Servo `GND` | GND | Must be common with the ESP32-C6 ground |

The panel is 4 modules (32×8 px), which is the number of digits the count gets.
Above 99999 the driver compacts numbers (`100k`, `1.0M`, `99M`, `999M`, `1B`).

## Build

ESP-IDF **v5.3.2**, target `esp32c6`.

```bash
git clone https://github.com/jettydiot/jettyd-firmware-template.git bell-rig
cd bell-rig
make setup                                    # clones the SDK into ./jettyd-sdk
git apply ../firmware/display-module-order.patch --directory=jettyd-sdk

cp ../firmware/device.yaml .
cp ../firmware/main.c main/

. $HOME/esp/esp-idf/export.sh
idf.py set-target esp32c6
idf.py build
```

`build.py` generates `main/device_config.h` and `main/driver_registry.c` from
`device.yaml`, so the pins and the servo home angle come from that file alone.
Confirm the generated registry before flashing:

```c
display_config_t display_cfg = { .pin_din = 10, .pin_clk = 8, .pin_cs = 9,
                                 .num_modules = 4, .brightness = 1 };
display_register("display", &display_cfg);

servo_config_t servo_cfg = { .pin = 3, .ledc_channel = 0, .min_pulse_us = 500,
                             .max_pulse_us = 2500, .max_angle = 180,
                             .home_angle = 90, .idle_detach = true };
servo_register("servo", &servo_cfg);
```

Note that the two drivers self-initialise inside their own `*_register()` call.
The `jettyd_driver_t.init` hook is never invoked by the core — do not add setup
code there expecting it to run.

## Flash

For a **new, unprovisioned** board, flash everything the normal way:

```bash
idf.py -p /dev/cu.usbmodem3101 flash monitor
```

For a board that is **already provisioned** — one that has a device identity,
WiFi credentials and a fleet token in NVS — flash the app partition **only**.
A full `idf.py flash` rewrites the partition table and can erase NVS, which
destroys the device identity and un-claims it from the platform:

```bash
# 1. Back up first. Always.
python3 -m esptool --chip esp32c6 --port /dev/cu.usbmodem3101 \
  read_flash 0x9000 0x6000 nvs-backup.bin

# 2. Write the app image only, into the active OTA slot.
python3 -m esptool --chip esp32c6 --port /dev/cu.usbmodem3101 --baud 460800 \
  --before default_reset --after no_reset \
  write_flash --flash_mode dio --flash_size keep --flash_freq 80m \
  0x20000 build/jettyd-device.bin

# 3. Verify.
python3 -m esptool --chip esp32c6 --port /dev/cu.usbmodem3101 \
  verify_flash 0x20000 build/jettyd-device.bin
```

`0x20000` is the `ota_0` offset on the verified rig. **Confirm the active slot
on your own board** by decoding `otadata` at `0xf000` rather than assuming —
active slot is `(ota_seq - 1) % 2`, and the entry is only valid if its CRC
matches `esp_rom_crc32_le(~0, &seq, 4)`. Never use `erase_flash`, and always
pass `--flash_size keep` so the image header is not rewritten.

## Expected boot log

```
I (502) jettyd:   Device: posthog-bell-counter-c6
I (542) jettyd_prov: Provision state: provisioned (tenant: …)
I (702) jettyd_drv: Registered driver: display (instance: display, caps: 0)
I (742) drv_display: Display init: DIN=10 CLK=8 CS=9 modules=4 brightness=1
I (742) jettyd_drv: Registered driver: servo (instance: servo, caps: 1)
I (762) drv_servo: Servo init: pin=3, ch=0, min_pulse=500 us, max_pulse=2500 us,
                   max_angle=180.0, home=90.0, idle_detach=1
I (782) drv_display: display.set: "----" brightness=1
I (792) bell: servo parked at home_angle, awaiting servo.rotate
I (802) bell: startup complete — parked and commandable
I (2632) jettyd_wifi: Connected, IP: …
I (3062) jettyd_mqtt: MQTT connected
I (3062) jettyd_manifest: Publishing manifest: {"drivers":["display","servo"],…}
I (3262) jettyd:   Jettyd running / Drivers: 2
```

The panel shows `----` and the horn does not move. If the horn sweeps on
power-up you have flashed the bench demo firmware, not this one.

## Bench-testing without the service

```bash
curl -X POST "$JETTYD_BASE_URL/v1/devices/$JETTYD_DEVICE_ID/commands" \
  -H "Authorization: Bearer $JETTYD_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"command_type":"servo.rotate","payload":{"angle":45,"hold_ms":250}}'

curl -X POST "$JETTYD_BASE_URL/v1/devices/$JETTYD_DEVICE_ID/commands" \
  -H "Authorization: Bearer $JETTYD_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"command_type":"display.set","payload":{"value":42}}'
```

Note the envelope: `command_type` / `payload`, never `action` / `params`.

## Known SDK rough edges

Observed on `jettyd-firmware` `main` (`95ea4c2`) while building this. None block
this device, but they will bite an adjacent one:

1. `devices/servo-actuator-v1/main.c` never calls `jettyd_register_drivers()`,
   so that device registers **zero** drivers and its servo never initialises.
2. Upstream device `main.c` files use `driver_manifest.h` / `JETTYD_MANIFEST_*`,
   but the template that actually builds them generates `device_config.h` /
   `DEVICE_*`. This device follows the template convention, because that is the
   one that compiles.
3. `jettyd_driver_t.init` is assigned by every driver and invoked by none.
4. `sdkconfig.defaults` sets `CONFIG_ESPTOOLPY_FLASHSIZE_4MB` while this board
   has 8 MB, hence the boot warning `Detected size(8192k) larger than the size
   in the binary image header(4096k)`. Harmless — the partition table ends at
   4 MB — but roughly 4 MB is left unusable.
