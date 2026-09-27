import json
import paho.mqtt.client as mqtt
from .config import BROKER_HOST, BROKER_PORT

class MqttPublisher:
    def __init__(self):
        self.client = mqtt.Client()
        self.client.connect(BROKER_HOST, BROKER_PORT, keepalive=60)
        self.client.loop_start()

    def publish_json(self, topic: str, payload: dict):
        self.client.publish(topic, json.dumps(payload), qos=0, retain=False)