const axios = require('axios');

async function callChatGPTAPI(messages, apiKey) {
    if (!apiKey) {
        console.error('OpenAI API anahtarı tanımlanmamış.');
        return null;
    }

    const apiUrl = 'https://api.openai.com/v1/chat/completions';
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
    };

    const data = {
        model: 'gpt-4', // Modeli uygun şekilde belirleyin
        messages: messages,
        max_tokens: 1000,
        temperature: 0.7,
    };

    try {
        console.log('ChatGPT API isteği gönderiliyor:', data);
        const response = await axios.post(apiUrl, data, { headers });
        console.log('ChatGPT API yanıtı alındı:', response.data);
        return response.data.choices[0].message.content.trim();
    } catch (error) {
        console.error('ChatGPT API hatası:', error.response?.data || error.message);
        return 'Bir hata oluştu. Lütfen daha sonra tekrar deneyin.';
    }
}

module.exports = callChatGPTAPI;
