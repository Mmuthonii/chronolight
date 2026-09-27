BROKER_HOST = "broker.emqx.io"
BROKER_PORT = 1883

DEVICE_ID = "esp32_1"

TOPIC_RAW = f"chronolight/esp32_1/raw"
TOPIC_CMD_BRIGHTNESS = "chronolight/esp32_1/cmd/brightness"

# Poll/logic preferences (you can expand later)
HISTORY_MAX = 60  # keep last 60 samples