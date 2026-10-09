const test = require('node:test');
const assert = require('node:assert/strict');
const { sendPushNotification } = require('./notificationService');

test('FCM delivery retries transient failures and reports the attempt count', async () => {
  let attempts = 0;
  const admin = {
    messaging: () => ({
      send: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('temporary failure');
      }
    })
  };
  const prisma = {
    user: {
      findUnique: async () => ({ deviceToken: 'device-token' })
    }
  };

  const result = await sendPushNotification(admin, prisma, {
    userId: 1,
    title: 'Test',
    body: 'Test body'
  }, 2);

  assert.equal(result.sent, true);
  assert.equal(result.attempts, 3);
});

test('FCM reports exhausted retries without throwing', async () => {
  const admin = {
    messaging: () => ({
      send: async () => {
        throw new Error('permanent failure');
      }
    })
  };
  const prisma = {
    user: {
      findUnique: async () => ({ deviceToken: 'device-token' })
    }
  };

  const result = await sendPushNotification(admin, prisma, {
    userId: 1,
    title: 'Test',
    body: 'Test body'
  }, 1);

  assert.equal(result.sent, false);
  assert.match(result.reason, /permanent failure/);
});
