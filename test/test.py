import paho.mqtt.client as mqtt

BROKER_HOST = "broker.emqx.io"
BROKER_PORT = 1883
TOPIC = "chronolight/#"

def on_connect(client, userdata, flags, rc, properties=None):
    print("sniffer connected", rc)
    client.subscribe(TOPIC)

def on_message(client, userdata, msg):
    payload = msg.payload.decode("utf-8", "ignore")
    print(f"[SNIFF] {msg.topic} -> {payload}")

client = mqtt.Client()
client.on_connect = on_connect
client.on_message = on_message
client.connect(BROKER_HOST, BROKER_PORT, 60)
client.loop_forever()