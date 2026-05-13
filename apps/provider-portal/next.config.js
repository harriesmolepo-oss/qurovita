/** @type {import('next').NextConfig} */
const nextConfig = {
  // The backend API runs on port 3000; rewrites handle HTTP but not WebSocket —
  // the session page connects directly to ws://localhost:3000 for simplicity.
};

export default nextConfig;
