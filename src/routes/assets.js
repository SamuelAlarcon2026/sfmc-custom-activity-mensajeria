const express = require('express');
const { listAssets, getAssetDetail, getAssetDebug } = require('../services/contentBuilderService');
const { getAccessToken, getSfmcBaseUrl } = require('../services/sfmcTokenService');

const router = express.Router();

router.get('/assets/diagnostics', async (_req, res, next) => {
  try {
    await getAccessToken();
    const restBaseUrl = await getSfmcBaseUrl();

    const result = await listAssets({
      page: 1,
      pageSize: 1,
      assetType: 'all'
    });

    res.json({
      success: true,
      sfmcToken: 'ok',
      restBaseUrl,
      assetApi: 'ok',
      method: result.method,
      sampleCount: result.items.length
    });
  } catch (err) {
    next(err);
  }
});

router.get('/assets', async (req, res, next) => {
  try {
    const result = await listAssets({
      page: req.query.page,
      pageSize: req.query.pageSize || req.query.limit,
      search: req.query.search || req.query.q,
      assetType: req.query.assetType,
      categoryId: req.query.categoryId || req.query.folderId
    });

    res.json({
      success: true,
      ...result
    });
  } catch (err) {
    next(err);
  }
});

router.get('/assets/:id/debug', async (req, res, next) => {
  try {
    const detail = await getAssetDebug(req.params.id);
    res.json({
      success: true,
      debug: detail
    });
  } catch (err) {
    next(err);
  }
});

router.get('/assets/:id', async (req, res, next) => {
  try {
    const detail = await getAssetDetail(req.params.id);
    res.json({
      success: true,
      asset: detail
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
