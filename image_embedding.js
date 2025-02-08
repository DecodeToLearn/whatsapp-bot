const axios = require('axios');
require('dotenv').config();

async function getImageEmbedding(imagePath) {
    // Jina API URL
    const url = 'https://api.jina.ai/v1/embeddings';

    console.log('getImageEmbedding fonksiyonuna girildi.'); // Log: Fonksiyona giriş

    // Jina API'ye gönderilecek veri
    const data = {
        model: 'jina-clip-v2',
        dimensions: 512, // Önerilen dimensions
        input: [
            {
                image: imagePath,
                text: "Focus primarily on the clothing worn by the model. The model's outfit, including fabrics, patterns, and colors, is the key detail. Other parts of the image should be embedded but with lower importance."
            }
        ]
    };

    // API isteği
    try {
        const response = await axios.post(url, data, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.JINA_API_KEY}` // Kendi API anahtarınızı ekleyin
            },
            timeout: 120000 // Zaman aşımı süresi artırıldı
        });

        if (response.status === 200 && response.data?.data?.[0]?.embedding) {
            const embedding = response.data.data[0].embedding;
            console.log('Embedding Yanıtı:', embedding); // Yanıtı logla
            console.log('getImageEmbedding fonksiyonundan çıkılıyor.'); // Log: Fonksiyondan çıkış
            return embedding; // Embedding değerini döndür
        } else {
            console.error('Embedding verisi bulunamadı:', response.data);
            return null;
        }
    } catch (error) {
        console.error('Jina API Hatası:', error.response?.data || error.message);
        console.log('getImageEmbedding fonksiyonundan çıkılıyor.'); // Log: Fonksiyondan çıkış
        return null;
    }
}

module.exports = { getImageEmbedding };
