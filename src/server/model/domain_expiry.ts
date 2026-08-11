// @ts-nocheck

import { SQLiteModel } from "@/server/sqlite-model";
import { log } from "@/server/logger";
import { TYPES_WITH_DOMAIN_EXPIRY_SUPPORT_VIA_FIELD } from "@/constants";
import rdapDnsDataFallback from "@/server/assets/rdap-dns.json" with { type: "json" };
import { sendNotification } from "@/server/notification-provider-registry";
import TranslatableError from "@/server/translatable-error";
import dayjs from "dayjs";

/**
 * Find the RDAP server for a given TLD
 * @param {string} tld TLD
 * @returns {string|null} First RDAP server found
 */
async function getRdapServer(tld, settings) {
    const rdapDnsData = await getRdapDnsData(settings);
    const services = rdapDnsData["services"] ?? [];
    const rootTld = tld?.split(".").pop();
    if (rootTld) {
        for (const [tlds, urls] of services) {
            if (tlds.includes(rootTld)) {
                return urls[0];
            }
        }
    }
    log.debug("rdap", `No RDAP server found for TLD ${tld}`);
    return null;
}

/**
 * Get RDAP DNS data from IANA and save to Setting
 * @returns {Promise<{}>} RDAP DNS data
 */
async function getRdapDnsData(settings) {
    const state = (settings.rdapDnsCache ||= { data: null, nextChecking: 0, running: false });
    // Cache for one week
    if (state.data && Date.now() < state.nextChecking) {
        return state.data;
    }

    // Avoid multiple simultaneous updates
    // Use older data first if another update is in progress
    if (state.running) {
        return await getOfflineRdapDnsData(settings);
    }

    try {
        state.running = true;
        log.info("rdap", "Updating RDAP DNS data from IANA...");
        const response = await fetch("https://data.iana.org/rdap/dns.json");
        if (!response.ok) {
            throw new Error(`HTTP error: ${response.status}`);
        }

        const data = await response.json();

        // Simple validation
        if (!data.services || !Array.isArray(data.services)) {
            throw new Error("Invalid RDAP DNS data structure");
        }

        state.data = data;

        // Next week
        state.nextChecking = Date.now() + 7 * 24 * 60 * 60 * 1000;
        await settings.set("rdapDnsData", data);
        log.info("rdap", "RDAP DNS data updated successfully. Number of services: " + data.services.length);
    } catch (error) {
        log.info("rdap", `Uable to update RDAP DNS data from source: ${error.message}`);
        state.data = await getOfflineRdapDnsData(settings);

        // Check again next day
        state.nextChecking = Date.now() + 24 * 60 * 60 * 1000;
    }

    state.running = false;
    return state.data;
}

/**
 * Get RDAP DNS data from Setting or hardcoded file as fallback
 * Fail safe
 * @returns {Promise<{}>} RDAP DNS data
 */
async function getOfflineRdapDnsData(settings) {
    let data = null;
    try {
        data = await settings.get("rdapDnsData");

        // Simple validation
        if (!data.services || !Array.isArray(data.services)) {
            throw new Error("Invalid RDAP DNS data structure");
        }
    } catch (e) {
        // If not downloaded previously, use the hardcoded data
        data = rdapDnsDataFallback;
    }
    return data;
}

/**
 * Request RDAP server to retrieve the expiry date of a domain
 * @param {string} domain Domain to retrieve the expiry date from
 * @returns {Promise<(Date|null)>} Expiry date from RDAP server
 */
async function getRdapDomainExpiryDate(domain, settings) {
    const { parse } = await import("tldts");
    const tld = parse(domain).publicSuffix;
    const rdapServer = await getRdapServer(tld, settings);
    if (rdapServer === null) {
        log.warn("rdap", `No RDAP server found, TLD ${tld} not supported.`);
        return null;
    }
    const url = `${rdapServer}domain/${domain}`;

    let rdapInfos;
    try {
        const res = await fetch(url);
        if (res.status !== 200) {
            return null;
        }
        rdapInfos = await res.json();
    } catch {
        log.warn("rdap", "Not able to get expiry date from RDAP");
        return null;
    }

    if (rdapInfos["events"] === undefined) {
        return null;
    }
    for (const event of rdapInfos["events"]) {
        if (event["eventAction"] === "expiration") {
            return new Date(event["eventDate"]);
        }
    }
    return null;
}

/**
 * Send a certificate notification when domain expires in less than target days
 * @param {NotificationProviderRegistry} providerRegistry Runtime-owned provider registry
 * @param {string} domain Domain we monitor
 * @param {number} daysRemaining Number of days remaining on certificate
 * @param {number} targetDays Number of days to alert after
 * @param {LooseObject<any>[]} notificationList List of notification providers
 * @returns {Promise<void>}
 */
async function sendDomainNotificationByTargetDays(
    providerRegistry,
    domain,
    daysRemaining,
    targetDays,
    notificationList
) {
    let sent = false;
    log.debug("domain_expiry", `Send domain expiry notification for ${targetDays} deadline.`);

    for (let notification of notificationList) {
        try {
            log.debug("domain_expiry", `Sending to ${notification.name}`);
            await sendNotification(
                providerRegistry,
                JSON.parse(notification.config),
                `Domain name ${domain} will expire in ${daysRemaining} days`
            );
            sent = true;
        } catch (e) {
            log.error("domain_expiry", `Cannot send domain notification to ${notification.name}:`, e);
        }
    }

    return sent;
}

class DomainExpiry extends SQLiteModel {
    /**
     * @param {string} domain Domain name
     * @returns {Promise<DomainExpiry>} Domain model
     */
    static async findByName(domain, store) {
        return store.findOne("domain_expiry", "domain = ?", [domain]);
    }

    /**
     * @param {string} domain Domain name
     * @returns {DomainExpiry} Domain model
     */
    static createByName(domain, store) {
        const d = store.createModel("domain_expiry");
        d.domain = domain;
        return d;
    }

    /**
     * @param {Monitor} monitor Monitor object
     * @throws {TranslatableError} Throws an error if the monitor type is unsupported or missing target.
     * @returns {Promise<{ domain: string, tld: string }>} Domain expiry support info
     */
    static async checkSupport(monitor, settings) {
        if (!(monitor.type in TYPES_WITH_DOMAIN_EXPIRY_SUPPORT_VIA_FIELD)) {
            throw new TranslatableError("domain_expiry_unsupported_monitor_type");
        }
        const targetField = TYPES_WITH_DOMAIN_EXPIRY_SUPPORT_VIA_FIELD[monitor.type];
        const target = monitor[targetField];
        if (typeof target !== "string" || target.length === 0) {
            throw new TranslatableError("domain_expiry_unsupported_missing_target");
        }

        const { parse } = await import("tldts");
        const tld = parse(target);

        // It must be checked first, filter out non-ICANN domains.
        if (!tld.isIcann) {
            throw new TranslatableError("domain_expiry_unsupported_is_icann", {
                // If domain is null, use hostname as fallback for better error message.
                domain: tld.domain ?? tld.hostname ?? "EMPTY DOMAIN",
                publicSuffix: tld.publicSuffix,
            });
        }

        const publicSuffix = tld.publicSuffix;
        const rootTld = publicSuffix.split(".").pop();
        const rdap = await getRdapServer(publicSuffix, settings);
        if (!rdap) {
            throw new TranslatableError("domain_expiry_unsupported_unsupported_tld_no_rdap_endpoint", {
                publicSuffix,
            });
        }

        return {
            domain: tld.domain,
            tld: rootTld,
        };
    }

    /**
     * @param {string} domainName Domain name
     * @returns {Promise<DomainExpiry>} Domain expiry model
     */
    static async findByDomainNameOrCreate(domainName, store) {
        let domain = await DomainExpiry.findByName(domainName, store);
        if (!domain && domainName) {
            domain = await DomainExpiry.createByName(domainName, store);
        }
        return domain;
    }

    /**
     * @returns {number} number of days remaining before expiry
     */
    get daysRemaining() {
        return dayjs.utc(this.expiry).diff(dayjs.utc(), "day");
    }

    /**
     * @returns {Promise<(Date|null)>} Expiry date from RDAP
     */
    async getExpiryDate(settings) {
        return getRdapDomainExpiryDate(this.domain, settings);
    }

    /**
     * @param {string} domainName Monitor object
     * @throws {TranslatableError} If the domain is not supported
     * @returns {Promise<Date | undefined>} the expiry date
     */
    static async checkExpiry(domainName, store, settings) {
        let model = await DomainExpiry.findByDomainNameOrCreate(domainName, store);
        let expiryDate;

        if (model?.lastCheck && dayjs.utc().diff(dayjs.utc(model.lastCheck), "day") < 1) {
            log.debug("domain_expiry", `Domain expiry already checked recently for ${model.domain}, won't re-check.`);
            return model.expiry;
        } else if (model) {
            expiryDate = await model.getExpiryDate(settings);

            if (dayjs.utc(expiryDate).isAfter(dayjs.utc(model.expiry))) {
                model.lastExpiryNotificationSent = null;
            }

            model.expiry = store.isoDateTimeMillis(expiryDate);
            model.lastCheck = store.isoDateTimeMillis(dayjs.utc());
            await store.saveModel(model);
        }

        if (expiryDate === null) {
            return;
        }

        return expiryDate;
    }

    /**
     * @param {NotificationProviderRegistry} providerRegistry Runtime-owned provider registry
     * @param {string} domainName the domain name to send notifications for
     * @param {LooseObject<any>[]} notificationList notification List
     * @returns {Promise<void>}
     */
    static async sendNotifications(providerRegistry, settings, store, domainName, notificationList) {
        const domain = await DomainExpiry.findByDomainNameOrCreate(domainName, store);
        if (!notificationList.length > 0) {
            // fail fast. If no notification is set, all the following checks can be skipped.
            log.debug("domain_expiry", "No notification, no need to send domain notification");
            return;
        }
        // sanity check if expiry date is valid before calculating days remaining. Should not happen and likely indicates a bug in the code.
        if (!domain.expiry || isNaN(new Date(domain.expiry).getTime())) {
            log.warn(
                "domain_expiry",
                `No valid expiry date passed to sendNotifications for ${domainName} (expiry: ${domain.expiry}), skipping notification`
            );
            return;
        }

        const daysRemaining = domain.daysRemaining;
        const lastSent = domain.lastExpiryNotificationSent;
        log.debug("domain_expiry", `${domainName} expires in ${daysRemaining} days`);

        let notifyDays = await settings.get("domainExpiryNotifyDays");
        if (notifyDays == null || !Array.isArray(notifyDays)) {
            // Reset Default
            await settings.set("domainExpiryNotifyDays", [7, 14, 21], "general");
            notifyDays = [7, 14, 21];
        }
        if (Array.isArray(notifyDays)) {
            // Asc sort to avoid sending multiple notifications if daysRemaining is below multiple targetDays
            notifyDays.sort((a, b) => a - b);
            for (const targetDays of notifyDays) {
                if (daysRemaining > targetDays) {
                    log.debug(
                        "domain_expiry",
                        `No need to send domain notification for ${domainName} (${daysRemaining} days valid) on ${targetDays} deadline.`
                    );
                    continue;
                } else if (lastSent && lastSent <= targetDays) {
                    log.debug(
                        "domain_expiry",
                        `Notification for ${domainName} on ${targetDays} deadline sent already, no need to send again.`
                    );
                    continue;
                }
                const sent = await sendDomainNotificationByTargetDays(
                    providerRegistry,
                    domainName,
                    daysRemaining,
                    targetDays,
                    notificationList
                );
                if (sent) {
                    domain.lastExpiryNotificationSent = targetDays;
                    await store.saveModel(domain);
                    return targetDays;
                }
            }
        }
    }
}

export default DomainExpiry;
