// ASKII stub — @huggingface/transformers requires sharp unconditionally, but
// ASKII only embeds text, so no image processing ever reaches it.
module.exports = function sharp() {
  throw new Error('sharp is stubbed out in ASKII — image inputs are not supported');
};
