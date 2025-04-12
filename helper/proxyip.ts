import tls from "tls";

interface ProxyStruct {
  address: string;
  port: number;
  country: string;
  org: string;
}

interface ProxyTestResult {
  error: boolean;
  message?: string;
  result?: {
    proxy: string;
    proxyip: boolean;
    ip: string;
    port: number;
    delay: number;
    country: string;
    asOrganization: string;
  };
}

let myGeoIpString: any = null;

const RAW_PROXY_LIST_FILE = "./rawProxyList.txt";
const PROXY_LIST_FILE = "./proxyList.txt";
const IP_RESOLVER_DOMAIN = "myip.jeelsboobz.workers.dev";
const IP_RESOLVER_PATH = "/";
const CONCURRENCY = 1000;

const CHECK_QUEUE: string[] = [];

async function sendRequest(host: string, path: string, proxy: any = null) {
  return new Promise((resolve, reject) => {
    const options = {
      host: proxy ? proxy.host : host,
      port: proxy ? proxy.port : 443,
      servername: host,
    };

    const socket = tls.connect(options, () => {
      const request =
        `GET ${path} HTTP/1.1\r\n` + `Host: ${host}\r\n` + `User-Agent: Mozilla/5.0\r\n` + `Connection: close\r\n\r\n`;
      socket.write(request);
    });

    let responseBody = "";
    socket.on("data", (data) => (responseBody += data.toString()));
    socket.on("end", () => {
      const body = responseBody.split("\r\n\r\n")[1] || "";
      resolve(body);
    });

    socket.on("error", (error) => reject(error));

    socket.setTimeout(5000, () => {
      reject(new Error("Request timeout"));
      socket.end();
    });
  });
}

export async function checkProxy(proxyAddress: string, proxyPort: number): Promise<ProxyTestResult> {
  let result: ProxyTestResult = {
    message: "Unknown error",
    error: true,
  };

  const proxyInfo = { host: proxyAddress, port: proxyPort };

  try {
    const start = new Date().getTime();
    const [ipinfo, myip] = await Promise.all([
      sendRequest(IP_RESOLVER_DOMAIN, IP_RESOLVER_PATH, proxyInfo),
      myGeoIpString == null ? sendRequest(IP_RESOLVER_DOMAIN, IP_RESOLVER_PATH, null) : myGeoIpString,
    ]);
    const finish = new Date().getTime();

    // Save local geoip
    if (myGeoIpString == null) myGeoIpString = myip;

    const parsedIpInfo = JSON.parse(ipinfo as string);
    const parsedMyIp = JSON.parse(myip as string);

    if (parsedIpInfo.ip && parsedIpInfo.ip !== parsedMyIp.ip) {
      result = {
        error: false,
        result: {
          proxy: proxyAddress,
          port: proxyPort,
          proxyip: true,
          delay: finish - start,
          ...parsedIpInfo,
        },
      };
    }
  } catch (error: any) {
    result.message = error.message;
  }

  return result;
}

async function readProxyList(): Promise<ProxyStruct[]> {
  const proxyList: ProxyStruct[] = [];

  const proxyListString = (await Bun.file(RAW_PROXY_LIST_FILE).text()).split("\n");
  for (const proxy of proxyListString) {
    if (!proxy.trim()) continue;
    
    // Handle both IP:PORT and IP,PORT,COUNTRY,ORG formats
    if (proxy.includes(',')) {
      const [address, port, country, org] = proxy.split(",");
      proxyList.push({
        address,
        port: parseInt(port),
        country,
        org,
      });
    } else if (proxy.includes(':')) {
      const [address, port] = proxy.split(":");
      proxyList.push({
        address,
        port: parseInt(port),
        country: 'Unknown',
        org: 'Unknown',
      });
    }
  }

  return proxyList;
}

(async () => {
  const proxyList = await readProxyList();
  const proxyChecked: string[] = [];
  const uniqueRawProxies: string[] = [];
  const activeProxyList: string[] = [];

  let proxySaved = 0;

  for (let i = 0; i < proxyList.length; i++) {
    const proxy = proxyList[i];
    const proxyKey = `${proxy.address}:${proxy.port}`;
    if (!proxyChecked.includes(proxyKey)) {
      proxyChecked.push(proxyKey);
      try {
        uniqueRawProxies.push(`${proxy.address}:${proxy.port}`);
      } catch (e: any) {
        continue;
      }
    } else {
      continue;
    }

    CHECK_QUEUE.push(proxyKey);
    checkProxy(proxy.address, proxy.port)
      .then((res) => {
        if (!res.error && res.result?.proxyip === true && res.result.country) {
          activeProxyList.push(`${res.result?.proxy}:${res.result?.port}`);
          proxySaved += 1;
          console.log(`[${i}/${proxyList.length}] Proxy saved:`, proxySaved);
        }
      })
      .finally(() => {
        CHECK_QUEUE.pop();
      });

    while (CHECK_QUEUE.length >= CONCURRENCY) {
      await Bun.sleep(1);
    }
  }

  // Waiting for all process to be completed
  while (CHECK_QUEUE.length) {
    await Bun.sleep(1);
  }

  await Bun.write(RAW_PROXY_LIST_FILE, uniqueRawProxies.join("\n"));
  await Bun.write(PROXY_LIST_FILE, activeProxyList.join("\n"));

  console.log(`Processing time: ${(Bun.nanoseconds() / 1000000000).toFixed(2)} seconds`);
  process.exit(0);
})();
