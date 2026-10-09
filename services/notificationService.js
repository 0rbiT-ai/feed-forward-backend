const sendPushNotification = async (admin, prisma, { userId, title, body, data = {}, retries = 2 }) => {
  if (!admin) return { sent: false, reason: 'FCM is not configured' };
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.deviceToken) return { sent: false, reason: 'No device token' };

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await admin.messaging().send({
        token: user.deviceToken,
        notification: { title, body },
        data: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, String(value)])),
      });
      return { sent: true, attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
    }
  }
  return { sent: false, reason: lastError?.message || 'FCM delivery failed' };
};

module.exports = { sendPushNotification };
