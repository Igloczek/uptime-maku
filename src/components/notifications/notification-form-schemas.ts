export type NotificationSchemaVariant = "smtp" | "chat" | "sms" | "template-body";

export type NotificationFieldType =
    | "url"
    | "text"
    | "secret"
    | "headers"
    | "select"
    | "number"
    | "checkbox"
    | "textarea"
    | "template-input"
    | "template-textarea"
    | "section"
    | "help-i18n";

export interface NotificationSelectOption {
    value: string | number | boolean;
    label?: string;
    labelKey?: string;
}

export interface NotificationHelpLink {
    keypath: string;
    href: string;
    linkText?: string;
    linkTextKey?: string;
}

export interface NotificationFormField {
    id: string;
    key: string;
    type: NotificationFieldType;
    labelKey?: string;
    placeholderKey?: string;
    placeholder?: string;
    required?: boolean;
    requiredMarker?: boolean;
    requiredUnlessRecipientGroup?: boolean;
    defaultValue?: string | number | boolean;
    options?: NotificationSelectOption[];
    helpTextKey?: string;
    helpLink?: NotificationHelpLink;
    moreInfoLink?: { href: string };
    documentationLink?: { href: string; labelKey: string; labelArgs?: string[] };
    min?: number;
    max?: number;
    step?: number;
    maxlength?: number;
    minlength?: number;
    pattern?: string;
    visibleWhen?: { field: string; equals?: unknown; notEquals?: unknown };
    fields?: NotificationFormField[];
    helpI18n?: {
        keypath: string;
        tag?: string;
        slots?: Record<string, string>;
    };
}

export interface NotificationFormSchema {
    id: string;
    variant?: NotificationSchemaVariant;
    fields: NotificationFormField[];
    defaults?: Record<string, string | number | boolean>;
    recipientGroupKeys?: string[];
}

type FieldOptions = Partial<Omit<NotificationFormField, "id" | "key" | "type" | "labelKey">>;

function urlField(id: string, key: string, labelKey: string, options: FieldOptions = {}): NotificationFormField {
    return { id, key, type: "url", labelKey, required: true, ...options };
}

function textField(id: string, key: string, labelKey: string, options: FieldOptions = {}): NotificationFormField {
    return { id, key, type: "text", labelKey, required: true, ...options };
}

function secretField(id: string, key: string, labelKey: string, options: FieldOptions = {}): NotificationFormField {
    return { id, key, type: "secret", labelKey, required: true, ...options };
}

function numberField(id: string, key: string, labelKey: string, options: FieldOptions = {}): NotificationFormField {
    return { id, key, type: "number", labelKey, required: true, ...options };
}

function selectField(
    id: string,
    key: string,
    labelKey: string,
    fieldOptions: NotificationSelectOption[],
    options: FieldOptions = {}
): NotificationFormField {
    return { id, key, type: "select", labelKey, required: true, options: fieldOptions, ...options };
}

function schema(
    id: string,
    fields: NotificationFormField[],
    options: {
        variant?: NotificationSchemaVariant;
        defaults?: Record<string, string | number | boolean>;
        recipientGroupKeys?: string[];
    } = {}
): NotificationFormSchema {
    const result: NotificationFormSchema = { id, fields };

    if (options.variant) {
        result.variant = options.variant;
    }

    if (options.defaults) {
        result.defaults = options.defaults;
    }

    if (options.recipientGroupKeys) {
        result.recipientGroupKeys = options.recipientGroupKeys;
    }

    return result;
}

function smtpVariantFields(): NotificationFormField[] {
    return [
        textField("hostname", "smtpHost", "Hostname"),
        {
            id: "smtp-host-help",
            key: "_smtpHostHelp",
            type: "help-i18n",
            helpI18n: {
                keypath:
                    "Either enter the hostname of the server you want to connect to or localhost if you intend to use a locally configured mail transfer agent",
                tag: "div",
            },
        },
        numberField("port", "smtpPort", "Port", { min: 0, max: 65535, step: 1 }),
        selectField(
            "secure",
            "smtpSecure",
            "Security",
            [
                { value: false, labelKey: "secureOptionNone" },
                { value: true, labelKey: "secureOptionTLS" },
            ],
            { required: true }
        ),
        {
            id: "ignore-tls-error",
            key: "smtpIgnoreTLSError",
            type: "checkbox",
            labelKey: "Ignore TLS Error",
            defaultValue: false,
        },
        {
            id: "ignore-starttls",
            key: "smtpIgnoreSTARTTLS",
            type: "checkbox",
            labelKey: "Disable STARTTLS",
            helpTextKey: "disableSTARTTLSDescription",
            visibleWhen: { field: "smtpSecure", equals: false },
        },
        textField("username", "smtpUsername", "Username", { required: false }),
        secretField("password", "smtpPassword", "Password", { required: false }),
        textField("from-email", "smtpFrom", "From Email", {
            placeholder: '"iglo.monitor" <alerts@example.com>',
        }),
        textField("to-email", "smtpTo", "To Email", {
            required: false,
            requiredUnlessRecipientGroup: true,
            placeholder: "ops@example.com, admin@example.com",
        }),
        textField("to-cc", "smtpCC", "smtpCC", { required: false, requiredUnlessRecipientGroup: true }),
        textField("to-bcc", "smtpBCC", "smtpBCC", { required: false, requiredUnlessRecipientGroup: true }),
        {
            id: "subject-email",
            key: "customSubject",
            type: "template-input",
            labelKey: "emailCustomSubject",
            required: false,
            helpTextKey: "leave blank for default subject",
        },
        {
            id: "body-email",
            key: "customBody",
            type: "template-textarea",
            labelKey: "emailCustomBody",
            required: false,
            helpTextKey: "leave blank for default body",
        },
        {
            id: "use-html-body",
            key: "htmlBody",
            type: "checkbox",
            labelKey: "Use HTML for custom E-mail body",
            defaultValue: false,
        },
        {
            id: "additional-headers",
            key: "smtpAdditionalHeaders",
            type: "headers",
            labelKey: "smtpAdditionalHeadersTitle",
            helpTextKey: "smtpAdditionalHeadersDesc",
            required: false,
        },
        {
            id: "dkim-section",
            key: "_dkimSection",
            type: "section",
            labelKey: "smtpDkimSettings",
            helpI18n: {
                keypath: "smtpDkimDesc",
                tag: "div",
            },
            fields: [
                textField("dkim-domain", "smtpDkimDomain", "smtpDkimDomain", {
                    required: false,
                    placeholder: "example.com",
                }),
                textField("dkim-key-selector", "smtpDkimKeySelector", "smtpDkimKeySelector", {
                    required: false,
                    placeholder: "2017",
                }),
                {
                    id: "dkim-private-key",
                    key: "smtpDkimPrivateKey",
                    type: "textarea",
                    labelKey: "smtpDkimPrivateKey",
                    required: false,
                    placeholder: "-----BEGIN PRIVATE KEY-----",
                },
                textField("dkim-hash-algo", "smtpDkimHashAlgo", "smtpDkimHashAlgo", {
                    required: false,
                    placeholder: "sha256",
                }),
                textField("dkim-header-fields", "smtpDkimheaderFieldNames", "smtpDkimheaderFieldNames", {
                    required: false,
                    placeholder: "message-id:date:from:to",
                }),
                textField("dkim-skip-fields", "smtpDkimskipFields", "smtpDkimskipFields", {
                    required: false,
                    placeholder: "message-id:date",
                }),
            ],
        },
    ];
}

function chatVariantFields(
    tokenKey: string,
    tokenLabelKey: string,
    targetKey: string,
    targetLabelKey: string,
    options: {
        serverUrlKey?: string;
        serverUrlLabelKey?: string;
        tokenHelpLink?: NotificationHelpLink;
        targetHelpTextKey?: string;
        extraFields?: NotificationFormField[];
    } = {}
): NotificationFormField[] {
    const fields: NotificationFormField[] = [
        secretField(`${tokenKey}-token`, tokenKey, tokenLabelKey, {
            helpLink: options.tokenHelpLink,
        }),
    ];

    if (options.serverUrlKey && options.serverUrlLabelKey) {
        fields.push(textField(`${options.serverUrlKey}-url`, options.serverUrlKey, options.serverUrlLabelKey));
    }

    fields.push(
        textField(`${targetKey}-id`, targetKey, targetLabelKey, {
            helpTextKey: options.targetHelpTextKey,
        })
    );

    if (options.extraFields) {
        fields.push(...options.extraFields);
    }

    return fields;
}

function smsApiKeyVariantFields(
    apiKeyKey: string,
    recipientKey: string,
    options: {
        apiKeyLabelKey?: string;
        recipientLabelKey?: string;
        senderKey?: string;
        senderLabelKey?: string;
        recipientType?: "text" | "number" | "textarea";
        apiHelpTextKey?: string;
        extraFields?: NotificationFormField[];
    } = {}
): NotificationFormField[] {
    const fields: NotificationFormField[] = [
        secretField(`${apiKeyKey}-key`, apiKeyKey, options.apiKeyLabelKey || "API Key", {
            helpTextKey: options.apiHelpTextKey,
        }),
    ];

    if (options.senderKey) {
        fields.push(
            textField(`${options.senderKey}-sender`, options.senderKey, options.senderLabelKey || "From Name/Number", {
                required: false,
            })
        );
    }

    const recipientType = options.recipientType || "text";
    const recipientId = `${recipientKey}-recipient`;
    const recipientLabel = options.recipientLabelKey || "Recipient Number";

    if (recipientType === "number") {
        fields.push(numberField(recipientId, recipientKey, recipientLabel));
    } else if (recipientType === "textarea") {
        fields.push({
            id: recipientId,
            key: recipientKey,
            type: "textarea",
            labelKey: recipientLabel,
            required: true,
        });
    } else {
        fields.push(textField(recipientId, recipientKey, recipientLabel));
    }

    if (options.extraFields) {
        fields.push(...options.extraFields);
    }

    return fields;
}

function smsCredentialsVariantFields(
    usernameKey: string,
    passwordKey: string,
    recipientKey: string,
    options: {
        usernameLabelKey?: string;
        passwordLabelKey?: string;
        recipientLabelKey?: string;
        senderKey?: string;
        senderLabelKey?: string;
        usernameHelpLink?: NotificationHelpLink;
        extraFields?: NotificationFormField[];
    } = {}
): NotificationFormField[] {
    const fields: NotificationFormField[] = [
        textField(`${usernameKey}-login`, usernameKey, options.usernameLabelKey || "API Username", {
            helpLink: options.usernameHelpLink,
        }),
        secretField(`${passwordKey}-key`, passwordKey, options.passwordLabelKey || "API Key"),
        textField(`${recipientKey}-number`, recipientKey, options.recipientLabelKey || "Recipient Number"),
    ];

    if (options.senderKey) {
        fields.push(
            textField(`${options.senderKey}-sender`, options.senderKey, options.senderLabelKey || "From Name/Number", {
                required: false,
            })
        );
    }

    if (options.extraFields) {
        fields.push(...options.extraFields);
    }

    return fields;
}

const flashDutySeverityOptions = [
    { value: "Info", label: "Info" },
    { value: "Warning", label: "Warning" },
    { value: "Critical", label: "Critical" },
];

const wpushChannelOptions = [
    { value: "wechat", label: "微信" },
    { value: "sms", label: "短信" },
    { value: "mail", label: "邮件" },
    { value: "feishu", label: "飞书" },
    { value: "dingtalk", label: "钉钉" },
    { value: "wechat_work", label: "企业微信" },
];

export const notificationFormSchemas: Record<string, NotificationFormSchema> = {
    Keep: schema(
        "Keep",
        [
            urlField("keep-host-url", "webhookURL", "Host URL", {
                helpLink: {
                    keypath: "Read more:",
                    href: "https://docs.keephq.dev/providers/documentation/uptimekuma-provider",
                },
            }),
            secretField("keep-api-key", "webhookAPIKey", "API Key"),
        ],
        { defaults: { webhookURL: "" } }
    ),
    squadcast: schema("squadcast", [urlField("squadcast-webhook-url", "squadcastWebhookURL", "Post URL")]),
    SIGNL4: schema("SIGNL4", [
        urlField("signl4-webhook-url", "webhookURL", "SIGNL4 Webhook URL", {
            helpLink: {
                keypath: "signl4Docs",
                href: "https://docs.signl4.com/integrations/uptime-kuma/uptime-kuma.html",
                linkText: "SIGNL4 Docs",
            },
        }),
    ]),
    pumble: schema("pumble", [
        urlField("pumble-webhook-url", "webhookURL", "Webhook URL", {
            requiredMarker: true,
            documentationLink: {
                href: "https://pumble.com/help/integrations/add-pumble-apps/incoming-webhooks-for-pumble/",
                labelKey: "documentationOf",
                labelArgs: ["Pumble Webbhook"],
            },
        }),
    ]),
    stackfield: schema("stackfield", [
        textField("stackfield-webhook-url", "stackfieldwebhookURL", "Webhook URL", {
            requiredMarker: true,
            helpTextKey: "Required",
            helpLink: {
                keypath: "aboutWebhooks",
                href: "https://www.stackfield.com/developer-api#AnchorAPI2",
            },
        }),
    ]),
    GoAlert: schema("GoAlert", [
        textField("goalert-base-url", "goAlertBaseURL", "Base URL", {
            helpLink: { keypath: "goAlertInfo", href: "https://goalert.me", linkText: "https://goalert.me" },
        }),
        secretField("goalert-token", "goAlertToken", "Token", { helpTextKey: "goAlertIntegrationKeyInfo" }),
    ]),
    PushPlus: schema("PushPlus", [
        secretField("pushplus-sendkey", "pushPlusSendKey", "SendKey", {
            moreInfoLink: { href: "https://www.pushplus.plus/" },
        }),
    ]),
    SpugPush: schema("SpugPush", [
        secretField("spugpush-template-key", "templateKey", "SpugPush Template Code", {
            moreInfoLink: { href: "https://push.spug.cc/guide/plugin/kuma" },
        }),
    ]),
    FlashDuty: schema("FlashDuty", [
        secretField("flashduty-integration-url", "flashdutyIntegrationKey", "FlashDuty Push URL", {
            placeholderKey: "FlashDuty Push URL Placeholder",
            requiredMarker: true,
            helpTextKey: "Required",
            helpLink: {
                keypath: "wayToGetFlashDutyKey",
                href: "https://flashcat.cloud/product/flashduty?from=kuma",
                linkTextKey: "here",
            },
        }),
        selectField("flashduty-severity", "flashdutySeverity", "FlashDuty Severity", flashDutySeverityOptions, {
            defaultValue: "Info",
        }),
    ]),
    GrafanaOncall: schema("GrafanaOncall", [
        textField("grafana-oncall-url", "GrafanaOncallURL", "GrafanaOncallURL", { requiredMarker: true }),
    ]),
    ZohoCliq: schema("ZohoCliq", [
        textField("zcliq-webhookurl", "webhookUrl", "Webhook URL", {
            helpLink: {
                keypath: "wayToGetZohoCliqURL",
                href: "https://www.zoho.com/cliq/help/platform/webhook-tokens.html",
                linkTextKey: "here",
            },
        }),
    ]),
    PushDeer: schema("PushDeer", [
        textField("pushdeer-server", "pushdeerServer", "PushDeer Server URL", {
            required: false,
            placeholder: "https://api2.pushdeer.com",
            helpTextKey: "pushDeerServerDescription",
        }),
        secretField("pushdeer-key", "pushdeerKey", "PushDeer Key", {
            placeholder: "PDUxxxx",
            moreInfoLink: { href: "http://www.pushdeer.com/" },
        }),
    ]),
    smtp: schema("smtp", smtpVariantFields(), {
        variant: "smtp",
        defaults: { smtpSecure: false },
        recipientGroupKeys: ["smtpTo", "smtpCC", "smtpBCC"],
    }),
    SendGrid: schema(
        "SendGrid",
        [
            secretField("sendgrid-api-key", "sendgridApiKey", "SendGrid API Key"),
            textField("sendgrid-from-email", "sendgridFromEmail", "From Email"),
            textField("sendgrid-to-email", "sendgridToEmail", "To Email"),
            textField("sendgrid-cc-email", "sendgridCcEmail", "smtpCC", { required: false }),
            textField("sendgrid-bcc-email", "sendgridBccEmail", "smtpBCC", { required: false }),
            textField("sendgrid-subject", "sendgridSubject", "Subject:", { required: false }),
        ],
        {
            variant: "template-body",
            defaults: { sendgridSubject: "Notification from Your iglo.monitor" },
        }
    ),
    Brevo: schema(
        "Brevo",
        [
            secretField("brevo-api-key", "brevoApiKey", "brevoApiKey", {
                helpLink: {
                    keypath: "brevoApiHelp",
                    href: "https://app.brevo.com/settings/keys/api",
                },
            }),
            textField("brevo-from-email", "brevoFromEmail", "brevoFromEmail"),
            textField("brevo-from-name", "brevoFromName", "brevoFromName", { required: false }),
            textField("brevo-to-email", "brevoToEmail", "brevoToEmail"),
            textField("brevo-cc-email", "brevoCcEmail", "brevoCcEmail", { required: false }),
            textField("brevo-bcc-email", "brevoBccEmail", "brevoBccEmail", { required: false }),
            textField("brevo-subject", "brevoSubject", "brevoSubject", { required: false }),
        ],
        {
            variant: "template-body",
            defaults: {
                brevoSubject: "Notification from Your iglo.monitor",
                brevoFromName: "iglo.monitor",
            },
        }
    ),
    Resend: schema(
        "Resend",
        [
            secretField("resend-api-key", "resendApiKey", "resendApiKey", {
                helpLink: {
                    keypath: "resendApiHelp",
                    href: "https://resend.com/api-keys",
                },
            }),
            textField("resend-from-email", "resendFromEmail", "resendFromEmail"),
            textField("resend-from-name", "resendFromName", "resendFromName", { required: false }),
            textField("resend-to-email", "resendToEmail", "resendToEmail"),
            textField("resend-subject", "resendSubject", "resendSubject", { required: false }),
        ],
        {
            variant: "template-body",
            defaults: {
                resendSubject: "Notification from Your iglo.monitor",
                resendFromName: "iglo.monitor",
            },
        }
    ),
    gotify: schema(
        "gotify",
        [
            secretField("gotify-application-token", "gotifyapplicationToken", "Application Token"),
            textField("gotify-server-url", "gotifyserverurl", "Server URL"),
            numberField("gotify-priority", "gotifyPriority", "Priority", { min: 0, max: 10, step: 1 }),
        ],
        { variant: "chat", defaults: { gotifyPriority: 8 } }
    ),
    line: schema(
        "line",
        chatVariantFields("lineChannelAccessToken", "Channel access token (Long-lived)", "lineUserID", "Your User ID", {
            tokenHelpLink: {
                keypath: "wayToGetLineChannelToken",
                href: "https://developers.line.biz/console/",
                linkTextKey: "Line Developers Console",
            },
        }),
        { variant: "chat" }
    ),
    Bitrix24: schema(
        "Bitrix24",
        [
            secretField("bitrix24-webhook-url", "bitrix24WebhookURL", "Bitrix24 Webhook URL", {
                helpLink: {
                    keypath: "wayToGetBitrix24Webhook",
                    href: "https://helpdesk.bitrix24.com/open/12357038/",
                },
            }),
            textField("bitrix24-user-id", "bitrix24UserID", "User ID", {
                helpTextKey: "bitrix24SupportUserID",
            }),
        ],
        { variant: "chat" }
    ),
    OneChat: schema(
        "OneChat",
        [
            secretField("onechat-access-token", "accessToken", "OneChat Access Token", {
                requiredMarker: true,
                helpTextKey: "OneChatAccessToken",
            }),
            textField("onechat-receiver-id", "recieverId", "OneChatUserIdOrGroupId", { requiredMarker: true }),
            textField("onechat-bot-id", "botId", "OneChatBotId", { requiredMarker: true }),
            {
                id: "onechat-docs",
                key: "_onechatDocs",
                type: "help-i18n",
                helpI18n: {
                    keypath: "Read more:",
                    tag: "p",
                },
                helpLink: {
                    keypath: "Read more:",
                    href: "https://chat-develop.one.th/docs",
                },
            },
        ],
        { variant: "chat" }
    ),
    notifery: schema(
        "notifery",
        [
            secretField("notifery-api-key", "notiferyApiKey", "API Key"),
            textField("notifery-title", "notiferyTitle", "Title", {
                required: false,
                placeholder: "iglo.monitor Alert",
            }),
            textField("notifery-group", "notiferyGroup", "Group", {
                required: false,
                placeholderKey: "Optional",
            }),
        ],
        { variant: "chat" }
    ),
    ServerChan: schema("ServerChan", [secretField("serverchan-sendkey", "serverChanSendKey", "SendKey")], {
        variant: "chat",
    }),
    HeiiOnCall: schema(
        "HeiiOnCall",
        [
            secretField("heiioncall-apikey", "heiiOnCallApiKey", "API Key", { requiredMarker: true }),
            secretField("heiioncall-trigger-id", "heiiOnCallTriggerId", "Trigger ID", { requiredMarker: true }),
            {
                id: "heiioncall-docs",
                key: "_heiioncallDocs",
                type: "help-i18n",
                helpI18n: { keypath: "wayToGetHeiiOnCallDetails", tag: "p" },
                helpLink: {
                    keypath: "wayToGetHeiiOnCallDetails",
                    href: "https://heiioncall.com/docs",
                },
            },
        ],
        { variant: "chat" }
    ),
    AlertNow: schema(
        "AlertNow",
        [
            textField("alertnow-webhook-url", "alertNowWebhookURL", "Webhook URL", {
                requiredMarker: true,
                helpTextKey: "Required",
                helpLink: {
                    keypath: "aboutWebhooks",
                    href: "https://service.opsnow.com/docs/alertnow/en/user-guide-alertnow-en.html#standard",
                    linkTextKey: "here",
                },
            }),
        ],
        { variant: "chat" }
    ),
    CallMeBot: schema(
        "CallMeBot",
        [
            textField("callmebot-endpoint", "callMeBotEndpoint", "Endpoint", {
                helpLink: {
                    keypath: "callMeBotGet",
                    href: "https://www.callmebot.com/blog/free-api-facebook-messenger/",
                },
            }),
        ],
        { variant: "chat" }
    ),
    WPush: schema(
        "WPush",
        [
            secretField("wpush-apikey", "wpushAPIkey", "API Key", { placeholder: "WPushxxxxx" }),
            selectField("wpush-channel", "wpushChannel", "发送通道", wpushChannelOptions),
        ],
        { variant: "chat" }
    ),
    FreeMobile: schema(
        "FreeMobile",
        [
            textField("freemobile-user", "freemobileUser", "Free Mobile User Identifier", { requiredMarker: true }),
            textField("freemobile-pass", "freemobilePass", "Free Mobile API Key", { requiredMarker: true }),
        ],
        { variant: "sms" }
    ),
    SevenIO: schema(
        "SevenIO",
        smsApiKeyVariantFields("sevenioApiKey", "sevenioReceiver", {
            apiKeyLabelKey: "apiKeySevenIO",
            senderKey: "sevenioSender",
            senderLabelKey: "senderSevenIO",
            recipientLabelKey: "receiverSevenIO",
            recipientType: "number",
            apiHelpTextKey: "wayToGetSevenIOApiKey",
            extraFields: [
                {
                    id: "sevenio-receiver-help",
                    key: "_sevenioReceiverHelp",
                    type: "help-i18n",
                    helpTextKey: "receiverInfoSevenIO",
                },
            ],
        }),
        { variant: "sms", defaults: { sevenioSender: "iglo.monitor" } }
    ),
    clicksendsms: schema(
        "clicksendsms",
        smsCredentialsVariantFields("clicksendsmsLogin", "clicksendsmsPassword", "clicksendsmsToNumber", {
            passwordLabelKey: "API Key",
            senderKey: "clicksendsmsSenderName",
            usernameHelpLink: {
                keypath: "wayToGetClickSendSMSToken",
                href: "http://dashboard.clicksend.com/account/subaccounts",
                linkTextKey: "here",
            },
            extraFields: [
                {
                    id: "clicksendsms-sender-help",
                    key: "_clicksendsmsSenderHelp",
                    type: "help-i18n",
                    helpTextKey: "Leave blank to use a shared sender number.",
                },
            ],
        }),
        { variant: "sms" }
    ),
    egosms: schema(
        "egosms",
        smsCredentialsVariantFields("egosmsUsername", "egosmsPassword", "egosmsPhoneNumber", {
            usernameLabelKey: "API Username",
            passwordLabelKey: "Password",
            recipientLabelKey: "Recipient Number",
            senderKey: "egosmsSender",
            usernameHelpLink: {
                keypath: "wayToGetEgoSMSToken",
                href: "https://www.egosms.co/",
                linkTextKey: "here",
            },
            extraFields: [
                {
                    id: "egosms-sender-help",
                    key: "_egosmsSenderHelp",
                    type: "help-i18n",
                    helpTextKey: "egosmsSenderDescription",
                },
                {
                    id: "egosms-phone-help",
                    key: "_egosmsPhoneHelp",
                    type: "help-i18n",
                    helpTextKey: "egosmsPhoneNumberDescription",
                },
            ],
        }),
        { variant: "sms", defaults: { egosmsSender: "EGOSMS" } }
    ),
    smsir: schema(
        "smsir",
        smsApiKeyVariantFields("smsirApiKey", "smsirNumber", {
            recipientLabelKey: "Recipient Numbers",
            extraFields: [
                textField("smsir-template", "smsirTemplate", "Template ID", { placeholder: "12345" }),
                {
                    id: "smsir-template-help",
                    key: "_smsirTemplateHelp",
                    type: "help-i18n",
                    helpI18n: { keypath: "wayToGetClickSMSIRTemplateID", tag: "div" },
                },
            ],
        }),
        { variant: "sms", defaults: { smsirNumber: "9123456789,09987654321" } }
    ),
    gtxmessaging: schema(
        "gtxmessaging",
        [
            secretField("gtxmessaging-api-key", "gtxMessagingApiKey", "API Key", {
                helpTextKey: "gtxMessagingApiKeyHint",
            }),
            textField(
                "gtxmessaging-from",
                "gtxMessagingFrom",
                "From Phone Number / Transmission Path Originating Address (TPOA)"
            ),
            textField("gtxmessaging-to", "gtxMessagingTo", "To Phone Number", { pattern: "^\\+\\d+$" }),
        ],
        { variant: "sms" }
    ),
    Elks: schema(
        "Elks",
        [
            textField("elks-username", "elksUsername", "Username"),
            secretField("elks-password", "elksAuthToken", "Password"),
            textField("elks-from-number", "elksFromNumber", "From"),
            textField("elks-to-number", "elksToNumber", "To Number"),
        ],
        { variant: "sms" }
    ),
    SMSPlanet: schema(
        "SMSPlanet",
        smsApiKeyVariantFields("smsplanetApiToken", "smsplanetPhoneNumbers", {
            apiKeyLabelKey: "smsplanetApiToken",
            recipientLabelKey: "Phone numbers",
            recipientType: "textarea",
            senderKey: "smsplanetSenderName",
            senderLabelKey: "Sender name",
            extraFields: [
                {
                    id: "smsplanet-sender-help",
                    key: "_smsplanetSenderHelp",
                    type: "help-i18n",
                    helpTextKey: "smsplanetNeedToApproveName",
                },
            ],
        }),
        { variant: "sms" }
    ),
    YZJ: schema(
        "YZJ",
        [
            urlField("yzj-webhook-url", "yzjWebHookUrl", "YZJ Webhook URL", { requiredMarker: true }),
            secretField("yzj-token", "yzjToken", "YZJ Robot Token", { requiredMarker: true }),
        ],
        { variant: "chat" }
    ),
    pushy: schema(
        "pushy",
        [
            secretField("pushy-app-token", "pushyAPIKey", "pushyAPIKey"),
            secretField("pushy-user-key", "pushyToken", "pushyToken"),
        ],
        { variant: "chat" }
    ),
};

export const genericNotificationFormTypes = Object.keys(notificationFormSchemas);
