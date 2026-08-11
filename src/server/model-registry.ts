// @ts-nocheck

import APIKey from "@/server/model/api_key";
import DomainExpiry from "@/server/model/domain_expiry";
import DockerHost from "@/server/model/docker_host";
import Group from "@/server/model/group";
import Heartbeat from "@/server/model/heartbeat";
import Incident from "@/server/model/incident";
import Maintenance from "@/server/model/maintenance";
import Monitor from "@/server/model/monitor";
import Proxy from "@/server/model/proxy";
import RemoteBrowser from "@/server/model/remote_browser";
import StatusPage from "@/server/model/status_page";
import Tag from "@/server/model/tag";
import User from "@/server/model/user";

// Literal imports are deliberate: Bun must see every model when compiling the executable.
export const MODEL_MAPPING = Object.freeze({
    api_key: APIKey,
    domain_expiry: DomainExpiry,
    docker_host: DockerHost,
    group: Group,
    heartbeat: Heartbeat,
    incident: Incident,
    maintenance: Maintenance,
    monitor: Monitor,
    proxy: Proxy,
    remote_browser: RemoteBrowser,
    status_page: StatusPage,
    tag: Tag,
    user: User,
});
