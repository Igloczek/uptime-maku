import { MonitorRuntimeRegistry, OPTIONAL_MONITOR_TYPES } from "@/server/monitor-runtime-registry";
import { NotificationProviderRegistry, OPTIONAL_NOTIFICATION_PROVIDERS } from "@/server/notification-provider-registry";
import DomainExpiry from "@/server/model/domain_expiry";
import { createCloudflaredRuntime } from "@/server/socket-handlers/cloudflared-socket-handler";
import { getWebpushVapidPublicKey } from "@/server/webpush-vapid";

const settings = { get: async () => null };
const server = { store: {}, settings, getUserAgent: () => "iglo.monitor compiled loader smoke" };
const monitorRegistry = new MonitorRuntimeRegistry(server);
const notificationRegistry = new NotificationProviderRegistry(settings);

const vapidSettings = new Map();
const publicVapidKey = await getWebpushVapidPublicKey({
    get: async (key) => vapidSettings.get(key),
    set: async (key, value) => vapidSettings.set(key, value),
});
if (!publicVapidKey || !vapidSettings.get("webpushPrivateVapidKey")) {
    throw new Error("Compiled Web Push VAPID generation failed");
}

const cloudflaredHandlers = new Map();
let cloudflaredJoined = false;
const cloudflared = createCloudflaredRuntime({ to: () => ({ emit() {} }) }, settings);
cloudflared.socketHandler(
    {
        userID: 1,
        join: () => {
            cloudflaredJoined = true;
        },
        leave() {},
        on: (event, handler) => cloudflaredHandlers.set(event, handler),
    },
    {}
);
await cloudflaredHandlers.get("cloudflared_join")();
if (!cloudflaredJoined) {
    throw new Error("Compiled Cloudflared dynamic load failed");
}

const domainSupport = await DomainExpiry.checkSupport(
    { type: "http", url: "https://status.example.com/path" },
    {
        rdapDnsCache: {
            data: { services: [[["com"], ["https://rdap.example/"]]] },
            nextChecking: Number.POSITIVE_INFINITY,
            running: false,
        },
    }
);

for (const name of OPTIONAL_MONITOR_TYPES) {
    if (!(await monitorRegistry.get(name))) {
        throw new Error(`Monitor factory returned no instance for ${name}`);
    }
}

for (const name of OPTIONAL_NOTIFICATION_PROVIDERS) {
    if (!(await notificationRegistry.get(name))) {
        throw new Error(`Notification provider factory returned no instance for ${name}`);
    }
}

console.log(
    JSON.stringify({
        monitors: OPTIONAL_MONITOR_TYPES.length,
        notificationProviders: OPTIONAL_NOTIFICATION_PROVIDERS.length,
        optionalStartup: {
            cloudflared: cloudflaredJoined,
            domain: domainSupport.domain,
            webpush: true,
        },
    })
);
