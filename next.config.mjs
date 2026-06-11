/** @type {import('next').NextConfig} */
const nextConfig = {
  // Windows + OneDrive + a space in the project path ("claude skills") makes
  // Next's jest-worker child processes fail to spawn ("Jest worker encountered
  // child process exceptions, exceeding retry limit"). Render in the main
  // process instead of spawning workers to avoid the crash.
  experimental: {
    workerThreads: false,
  },
};

export default nextConfig;
