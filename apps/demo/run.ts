import { startDemoServer } from './backend/server';
import { createDemoClient } from './frontend/client';

async function runDemo() {
  const rabbitConfig = {
    url: process.env.SCOMP_RABBITMQ_URL ?? 'amqp://localhost:5672',
    prefetch: 20
  };

  await startDemoServer(rabbitConfig);

  const { client } = createDemoClient(rabbitConfig);

  const user = await client.users.getUser({ id: 1 });
  console.log('request result:', user);

  await client.users.notifyLogin({
    userId: user.id,
    at: new Date().toISOString()
  });
  console.log('signal sent: users.notifyLogin');

  let seen = 0;
  for await (const tick of client.users.liveTicker({ channel: 'prices' })) {
    console.log('feed chunk:', tick);
    seen += 1;
    if (seen >= 3) {
      break;
    }
  }

  console.log('feed loop broken after 3 chunks, cleanup should trigger via mandatory publish returns.');
}

void runDemo();
