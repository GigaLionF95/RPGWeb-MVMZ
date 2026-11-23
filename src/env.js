// Imported first by the CLI. Node's thread pool (default 4 threads) serves
// both file reads and zlib; give it room so compressing never delays serving.
process.env.UV_THREADPOOL_SIZE ||= '8';
