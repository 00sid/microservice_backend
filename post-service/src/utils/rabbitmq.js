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

module.exports = { connectTORabbitMq };
