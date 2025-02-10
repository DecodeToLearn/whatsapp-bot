const axios = require('axios');

async function findProductByEmbedding(imageEmbedding, userLanguage) {
    const apiUrl = 'https://wp.clupfashion.com/api/find-product.php'; // PHP API endpoint
    try {
        const response = await axios.post(apiUrl, {
            imageEmbedding: imageEmbedding,
            userLanguage: userLanguage || 'en' // Varsayılan dil İngilizce
        });

        if (response.data.status === 'success') {
            console.log('Ürün bulundu:', response.data.product);
            return response.data.product; // Ürün bilgilerini döndür
        } else {
            console.error('Ürün bulunamadı:', response.data.message);
            return null; // Ürün bulunamazsa null döndür
        }
    } catch (error) {
        console.error('API isteği sırasında hata oluştu:', error.message);
        return null; // Hata durumunda null döndür
    }
}

module.exports = findProductByEmbedding;