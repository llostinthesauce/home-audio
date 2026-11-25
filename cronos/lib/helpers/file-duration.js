// music-metadata 11 is ESM-only, so this CommonJS module loads it with a dynamic import.
// The `default` fallback keeps it working with the old 1.x tree until node_modules is rebuilt.
function fileDuration(path) {
  return import('music-metadata')
      .then((mm) => (mm.parseFile || mm.default.parseFile)(path, { duration: true }))
      .then((info) => {
        return Math.ceil(info.format.duration * 1000);
      });
}

module.exports = fileDuration;
