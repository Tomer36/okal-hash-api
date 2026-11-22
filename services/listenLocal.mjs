import http from "http";

// The service is reached only from the same server (the gateway on :5000 and auth-service's
// template client), so it listens on the loopback addresses only and nothing on the network can
// reach it. Both IPv4 and IPv6 loopback, because "localhost" may resolve to either. An address
// the machine does not have (e.g. IPv6 turned off) is skipped with a warning; at least one must
// work.
export const LOCAL_HOSTS = ["127.0.0.1", "::1"];

export async function listenLocal(app, port, { hosts = LOCAL_HOSTS, warn = console.warn } = {}) {
  const servers = [];
  for (const host of hosts) {
    const server = http.createServer(app);
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      servers.push(server);
    } catch (error) {
      warn(`Hash microservice could not listen on ${host}:${port}: ${error.code || error.message}`);
    }
  }
  if (servers.length === 0) throw new Error(`Hash microservice could not listen on port ${port}`);
  return servers;
}
