const TelegramBot = require('node-telegram-bot-api');
const http = require('http');

const BOT_TOKEN = process.env.MAIN_TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || '';
const BACKEND_HOST = process.env.BACKEND_HOST || '127.0.0.1';
const BACKEND_PORT = Number(process.env.BACKEND_PORT || process.env.PORT || 3000);

if (!BOT_TOKEN) {
  console.log('Main bot token not configured. Set MAIN_TELEGRAM_BOT_TOKEN or BOT_TOKEN.');
  module.exports = null;
} else {

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

let userStates = {};

const steps = [
  { key: 'name', prompt: 'Enter user full name:' },
  { key: 'purpose', prompt: 'Enter withdrawal purpose:' },
  { key: 'amount', prompt: 'Enter withdrawal amount:' },
  { key: 'photo', prompt: 'Upload user profile photo:' }
];

function sendToServer(payload) {
  const postData = JSON.stringify(payload);
  const options = {
    hostname: BACKEND_HOST,
    port: BACKEND_PORT,
    path: '/api/telegram-withdrawal',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  const req = http.request(options, () => {
    console.log(`Sent to server with withdrawalId: ${payload.withdrawalId} (${(payload.uiType || 'uia').toUpperCase()})`);
  });

  req.on('error', (e) => {
    console.error(`Problem: ${e.message}`);
  });

  req.write(postData);
  req.end();
}

function parseWithdrawalAndInvite(data, prefix) {
  const body = data.slice(prefix.length);
  const parts = body.split('_');
  const withdrawalId = Number.parseInt(parts[0], 10);
  const inviteCode = parts.length > 1 ? parts[1].toUpperCase() : null;
  return {
    withdrawalId,
    inviteCode: inviteCode && inviteCode !== 'NA' ? inviteCode : null
  };
}

// Handle UI A / UI B / UI C button clicks
bot.on('callback_query', async (query) => {
  const userId = query.from.id;
  const data = query.data;

  if (data.startsWith('approve_')) {
    const parsed = parseWithdrawalAndInvite(data, 'approve_');
    userStates[userId] = {
      step: 0,
      data: { name: '', purpose: '', amount: '', photo: null },
      withdrawalId: parsed.withdrawalId,
      uiType: 'uia',
      inviteCode: parsed.inviteCode
    };

    bot.answerCallbackQuery(query.id);
    bot.sendMessage(userId, `Starting data collection...\n\n${steps[0].prompt}`);
    return;
  }

  if (data.startsWith('decline_')) {
    const parsed = parseWithdrawalAndInvite(data, 'decline_');
    userStates[userId] = {
      step: 0,
      data: { name: '', username: '', amount: '', photo: null },
      withdrawalId: parsed.withdrawalId,
      uiType: 'uib',
      inviteCode: parsed.inviteCode
    };

    bot.answerCallbackQuery(query.id);
    bot.sendMessage(userId, `Starting data collection...\n\n${steps[0].prompt}`);
    return;
  }

  // UI C: no data collection, immediate denial event
  if (data.startsWith('review_')) {
    const parsed = parseWithdrawalAndInvite(data, 'review_');
    const withdrawalId = parsed.withdrawalId;

    bot.answerCallbackQuery(query.id);
    sendToServer({
      withdrawalId,
      inviteCode: parsed.inviteCode,
      uiType: 'uic',
      timestamp: new Date().toISOString()
    });

    bot.sendMessage(userId, `UI C sent for #${withdrawalId}. Payment denied.`);
    return;
  }

  if (data.startsWith('verify_approve_a_')) {
    const parsed = parseWithdrawalAndInvite(data, 'verify_approve_a_');
    bot.answerCallbackQuery(query.id);
    sendToServer({
      withdrawalId: parsed.withdrawalId,
      inviteCode: parsed.inviteCode,
      action: 'verify_approve_a',
      timestamp: new Date().toISOString()
    });
    bot.sendMessage(userId, `Approved A for #${parsed.withdrawalId}.`);
    return;
  }

  if (data.startsWith('verify_approve_b_')) {
    const parsed = parseWithdrawalAndInvite(data, 'verify_approve_b_');
    bot.answerCallbackQuery(query.id);
    sendToServer({
      withdrawalId: parsed.withdrawalId,
      inviteCode: parsed.inviteCode,
      action: 'verify_approve_b',
      timestamp: new Date().toISOString()
    });
    bot.sendMessage(userId, `Approved B for #${parsed.withdrawalId}.`);
    return;
  }

  if (data.startsWith('verify_reject_')) {
    const parsed = parseWithdrawalAndInvite(data, 'verify_reject_');
    bot.answerCallbackQuery(query.id);
    sendToServer({
      withdrawalId: parsed.withdrawalId,
      inviteCode: parsed.inviteCode,
      action: 'verify_reject',
      timestamp: new Date().toISOString()
    });
    bot.sendMessage(userId, `Rejected verification for #${parsed.withdrawalId}.`);
    return;
  }

  if (data.startsWith('stage2_approve_')) {
    const parsed = parseWithdrawalAndInvite(data, 'stage2_approve_');
    bot.answerCallbackQuery(query.id);
    sendToServer({
      withdrawalId: parsed.withdrawalId,
      inviteCode: parsed.inviteCode,
      action: 'stage2_approve',
      timestamp: new Date().toISOString()
    });
    bot.sendMessage(userId, `Stage 2 approved for #${parsed.withdrawalId}.`);
    return;
  }

  if (data.startsWith('stage2_reject_')) {
    const parsed = parseWithdrawalAndInvite(data, 'stage2_reject_');
    bot.answerCallbackQuery(query.id);
    sendToServer({
      withdrawalId: parsed.withdrawalId,
      inviteCode: parsed.inviteCode,
      action: 'stage2_reject',
      timestamp: new Date().toISOString()
    });
    bot.sendMessage(userId, `Stage 2 rejected for #${parsed.withdrawalId}.`);
  }
});

// Handle messages for UI A / UI B collection
bot.on('message', async (msg) => {
  const userId = msg.from.id;
  const userState = userStates[userId];

  if (!userState) return;

  const currentStep = steps[userState.step];

  if (userState.step < 3 && msg.text) {
    const input = msg.text.trim();

    if (userState.step === 0 && input.length < 2) {
      return bot.sendMessage(userId, 'Name too short. Try again:');
    }

    if (userState.step === 2) {
      if (isNaN(input) || parseFloat(input) <= 0) {
        return bot.sendMessage(userId, 'Invalid amount. Numbers only:');
      }
      userState.data.amount = parseFloat(input);
    } else if (userState.uiType === 'uib' && userState.step === 1) {
      userState.data.username = input;
    } else {
      userState.data[currentStep.key] = input;
    }

    userState.step++;

    if (userState.step < steps.length) {
      bot.sendMessage(userId, steps[userState.step].prompt);
    }
    return;
  }

  if (userState.step === 3 && msg.photo) {
    try {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      const file = await bot.getFile(fileId);
      const photoUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

      userState.data.photo = photoUrl;

      const confirmMessage = userState.uiType === 'uib'
        ? `Data sent!\n\nName: ${userState.data.name}\nUsername: ${userState.data.username}\nAmount: $${userState.data.amount}\n\nCheck your web app!`
        : `Data sent!\n\nName: ${userState.data.name}\nPurpose: ${userState.data.purpose}\nAmount: $${userState.data.amount}\n\nCheck your web app!`;

      bot.sendMessage(userId, confirmMessage);

      sendToServer({
        withdrawalId: userState.withdrawalId,
        inviteCode: userState.inviteCode || null,
        name: userState.data.name,
        purpose: userState.uiType === 'uib' ? userState.data.username : userState.data.purpose,
        username: userState.uiType === 'uib' ? userState.data.username : null,
        amount: userState.data.amount,
        profileImage: userState.data.photo,
        uiType: userState.uiType,
        timestamp: new Date().toISOString()
      });

      delete userStates[userId];
    } catch (error) {
      console.error('Error:', error.message);
      bot.sendMessage(userId, 'Failed. Try again:');
    }
    return;
  }

  if (userState.step < 3 && !msg.text) {
    bot.sendMessage(userId, `Send text:\n\n${currentStep.prompt}`);
  } else if (userState.step === 3 && !msg.photo) {
    bot.sendMessage(userId, 'Send a photo:');
  }
});

console.log('Bot ready');
module.exports = bot;
}
