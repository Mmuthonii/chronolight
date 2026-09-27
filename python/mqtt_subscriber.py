import json
from typing import Callable, Optional

import paho.mqtt.client as mqtt

from .config import BROKER_HOST, BROKER_PORT, TOPIC_RAW, HISTORY_MAX
from .state import SharedState

OnRawFn = Callable[[SharedState, dict], None]

def start_mqtt_subscriber(shared: SharedState, on_raw: Optional[OnRawFn] = None) -> mqtt.Client:
    """Start MQTT subscriber in background thread.
    If provided, `on_raw(shared, payload_dict)` runs after the shared state update.
    """
    client = mqtt.Client()

    def on_connect(c, userdata, flags, rc):
        if rc == 0:
            print(f"[MQTT] Connected to {BROKER_HOST}:{BROKER_PORT}")
            c.subscribe(TOPIC_RAW)
            print(f"[MQTT] Subscribed to {TOPIC_RAW}")
        else:
            print(f"[MQTT] Connect failed rc={rc}")

    def on_message(c, userdata, msg):
        try:
            raw = msg.payload.decode("utf-8", errors="ignore")
            data = json.loads(raw)
            if isinstance(data, dict):
                shared.update_from_raw(data, history_max=HISTORY_MAX)
                if on_raw:
                    try:
                        on_raw(shared, data)
                    except Exception as e:
                        print(f"[AUTO] on_raw error: {e}")
        except Exception as e:
            print(f"[MQTT] Bad message on {msg.topic}: {e}")

    client.on_connect = on_connect
    client.on_message = on_message

    client.connect(BROKER_HOST, BROKER_PORT, keepalive=60)
    client.loop_start()
    return client
