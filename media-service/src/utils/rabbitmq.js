const amqp = require("amqplib");

const logger = require("./logger");

const EXCHANGE_NAME = "facebook-post";
let connection = null;
let channel = null;

async function connectTORabbitMq() {
  try {
    connection = await amqp.connect(process.env.RABBITMQ_URL);
    channel = await connection.createChannel();
    await channel.assertExchange(EXCHANGE_NAME, "topic", { durable: false });
    logger.info("Connected to rabbit mq");
    return channel;
  } catch (error) {
    logger.error("Error while connecting to rabbit mq", error);
  }
}

async function publishEvent(routingKey, message) {
  try {
    if (!channel) {
      await connectTORabbitMq();
    }
    channel.publish(
      EXCHANGE_NAME,
      routingKey,
      Buffer.from(JSON.stringify(message)),
      logger.info(`Event publish from post service: ${routingKey}`),
    );
  } catch (error) {
    logger.error("Error while publishing event to rabbit mq", error);
  }
}
async function consumeEvent(routingKey, callback) {
  try {
    if (!channel) {
      await connectTORabbitMq();
    }

    const q = await channel.assertQueue("", { exclusive: true });
    await channel.bindQueue(q.queue, EXCHANGE_NAME, routingKey);
    channel.consume(q.queue, (msg) => {
      if (msg !== null) {
        const content = JSON.parse(msg.content.toString());
        callback(content);
        channel.ack(msg);
      }
    });
    logger.info(`Subscribed to event:${routingKey}`);
  } catch (error) {
    logger.error("Error while subscribing to rabbit mq", error);
  }
}

module.exports = { connectTORabbitMq, publishEvent, consumeEvent };
