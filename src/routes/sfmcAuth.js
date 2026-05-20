const express = require('express');
const { getAccessToken, getSfmcBaseUrl } = require('../services/sfmcTokenService');

const router = express.Router();

router.get('/sfmc/token-status', async (req, res, next) => {
  try {
    await getAccessToken();
    const restBaseUrl = await getSfmcBaseUrl();

    res.json({
      success: true,
      message: 'Token SFMC disponible.',
      restBaseUrl
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;