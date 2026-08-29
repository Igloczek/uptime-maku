<template>
    <form @submit.prevent="submit">
        <div ref="modal" class="modal fade" tabindex="-1" data-bs-backdrop="static" @keydown.esc.stop="hide">
            <div class="modal-dialog">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 id="exampleModalLabel" class="modal-title">
                            {{ $t("Setup Notification") }}
                        </h5>
                        <button type="button" class="btn-close" :aria-label="$t('Close')" @click="hide" />
                    </div>
                    <div class="modal-body">
                        <div class="mb-3">
                            <label for="notification-type" class="form-label">{{ $t("Notification Type") }}</label>
                            <select
                                id="notification-type"
                                ref="firstInput"
                                v-model="notification.type"
                                class="form-select"
                            >
                                <optgroup
                                    v-for="category in notificationCategories"
                                    :key="category.id"
                                    :label="$t(category.labelKey)"
                                >
                                    <option
                                        v-for="(name, type) in notificationNameList[category.id]"
                                        :key="type"
                                        :value="type"
                                    >
                                        {{ name }}
                                    </option>
                                </optgroup>
                            </select>
                        </div>

                        <div class="mb-3">
                            <label for="notification-name" class="form-label">{{ $t("Friendly Name") }}</label>
                            <input
                                id="notification-name"
                                v-model="notification.name"
                                type="text"
                                class="form-control"
                                required
                            />
                        </div>

                        <!-- form body -->
                        <Suspense v-if="currentForm">
                            <component :is="currentForm" :notification="notification" />
                            <template #fallback>
                                <div class="d-flex justify-content-center py-3">
                                    <div class="spinner-border spinner-border-sm" role="status"></div>
                                </div>
                            </template>
                        </Suspense>

                        <div class="mb-3 mt-4">
                            <label for="notification-resend-interval" class="form-label">
                                {{ $t("Resend notification while down") }}
                                <span v-if="notification.resendInterval > 0">
                                    ({{ $t("resendEveryXMinutes", [notification.resendInterval]) }})
                                </span>
                                <span v-else>({{ $t("resendDisabled") }})</span>
                            </label>
                            <input
                                id="notification-resend-interval"
                                v-model="notification.resendInterval"
                                type="number"
                                class="form-control"
                                required
                                min="0"
                                step="1"
                            />
                            <div class="form-text">{{ $t("resendIntervalDescription") }}</div>
                        </div>

                        <div class="mb-3 mt-4">
                            <hr class="dropdown-divider mb-4" />

                            <div class="form-check form-switch">
                                <input v-model="notification.isDefault" class="form-check-input" type="checkbox" />
                                <label class="form-check-label">{{ $t("Default enabled") }}</label>
                            </div>
                            <div class="form-text">
                                {{ $t("enableDefaultNotificationDescription") }}
                            </div>

                            <br />

                            <div class="form-check form-switch">
                                <input v-model="notification.applyExisting" class="form-check-input" type="checkbox" />
                                <label class="form-check-label">{{ $t("Apply on all existing monitors") }}</label>
                            </div>
                        </div>
                    </div>

                    <div class="modal-footer">
                        <button
                            v-if="id"
                            type="button"
                            class="btn btn-danger"
                            :disabled="processing"
                            @click="deleteConfirm"
                        >
                            {{ $t("Delete") }}
                        </button>
                        <button type="button" class="btn btn-warning" :disabled="processing" @click="test">
                            {{ $t("Test") }}
                        </button>
                        <button type="submit" class="btn btn-primary" :disabled="processing">
                            <div v-if="processing" class="spinner-border spinner-border-sm me-1"></div>
                            {{ $t("Save") }}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </form>

    <Confirm
        ref="confirmDelete"
        btn-style="btn-danger"
        :yes-text="$t('Yes')"
        :no-text="$t('No')"
        @yes="deleteNotification"
    >
        {{ $t("deleteNotificationMsg") }}
    </Confirm>
</template>

<script>
import { Modal } from "bootstrap";

import Confirm from "@/components/Confirm.vue";
import NotificationFormList, { notificationProviderTypes } from "@/components/notifications";
import { NOTIFICATION_PROVIDER_CATEGORIES, buildNotificationNameList } from "@/notification-provider-metadata";

export default {
    components: {
        Confirm,
    },
    props: {},
    emits: ["added"],
    data() {
        return {
            model: null,
            processing: false,
            id: null,
            notificationTypes: [...notificationProviderTypes].sort((a, b) => {
                return a.toLowerCase().localeCompare(b.toLowerCase());
            }),
            notification: {
                name: "",
                /** @type { null | keyof NotificationFormList } */
                type: null,
                isDefault: false,
                // Do not set default value here, please scroll to show()
            },
        };
    },

    computed: {
        currentForm() {
            if (!this.notification.type) {
                return null;
            }
            return NotificationFormList[this.notification.type];
        },

        notificationCategories() {
            return NOTIFICATION_PROVIDER_CATEGORIES;
        },

        notificationNameList() {
            return buildNotificationNameList(this.$t.bind(this));
        },

        notificationFullNameList() {
            let list = {};
            // Combine all categories into a single list
            for (let category of Object.values(this.notificationNameList)) {
                for (let [key, value] of Object.entries(category)) {
                    list[key] = value;
                }
            }
            return list;
        },
    },

    watch: {
        "notification.type"(to, from) {
            let oldName;
            if (from) {
                oldName = this.getUniqueDefaultName(from);
            } else {
                oldName = "";
            }

            if (!this.notification.name || this.notification.name === oldName) {
                this.notification.name = this.getUniqueDefaultName(to);
            }
        },
    },
    mounted() {
        this.modal = new Modal(this.$refs.modal);
        this.$refs.modal.addEventListener("shown.bs.modal", this.focusFirstInput);
        this.$refs.modal.addEventListener("hidden.bs.modal", this.restoreFocus);
    },
    beforeUnmount() {
        this.cleanupModal();
    },
    methods: {
        /**
         * Show dialog to confirm deletion
         * @returns {void}
         */
        deleteConfirm() {
            this.modal.hide();
            this.$refs.confirmDelete.show();
        },

        /**
         * Show settings for specified notification
         * @param {number} notificationID ID of notification to show
         * @returns {void}
         */
        show(notificationID) {
            this.returnFocus = document.activeElement;

            if (notificationID) {
                this.id = notificationID;

                for (let n of this.appStore.notificationList) {
                    if (n.id === notificationID) {
                        this.notification = JSON.parse(n.config);
                        this.notification.resendInterval ??= 0;

                        // applyExisting is one time only, but it got saved to database previously. Workaround fix, set it to false here to deal with the problem.
                        this.notification.applyExisting = false;

                        break;
                    }
                }
            } else {
                this.id = null;
                this.notification = {
                    name: "",
                    type: "telegram",
                    isDefault: false,
                    resendInterval: 0,
                };
            }

            this.modal.show();
        },

        hide() {
            this.modal.hide();
        },

        focusFirstInput() {
            this.$refs.firstInput?.focus();
        },

        restoreFocus() {
            this.returnFocus?.focus();
            this.returnFocus = null;
        },

        /**
         * Submit the form to the server
         * @returns {void}
         */
        submit() {
            this.processing = true;
            this.appStore.getSocket().emit("addNotification", this.notification, this.id, (res) => {
                this.appStore.toastRes(res);
                this.processing = false;

                if (res.ok) {
                    this.modal.hide();

                    // Emit added event, doesn't emit edit.
                    if (!this.id) {
                        this.$emit("added", res.id);
                    }
                }
            });
        },

        /**
         * Test the notification endpoint
         * @returns {void}
         */
        test() {
            this.processing = true;
            this.appStore.getSocket().emit("testNotification", this.notification, (res) => {
                this.appStore.toastRes(res);
                this.processing = false;
            });
        },

        /**
         * Delete the notification endpoint
         * @returns {void}
         */
        deleteNotification() {
            this.processing = true;
            this.appStore.getSocket().emit("deleteNotification", this.id, (res) => {
                this.appStore.toastRes(res);
                this.processing = false;

                if (res.ok) {
                    this.modal.hide();
                }
            });
        },
        /**
         * Get a unique default name for the notification
         * @param {keyof NotificationFormList} notificationKey
         * Notification to retrieve
         * @returns {string} Default name
         */
        getUniqueDefaultName(notificationKey) {
            let index = 1;
            let name = "";
            do {
                name = this.$t("defaultNotificationName", {
                    notification: this.notificationFullNameList[notificationKey].replace(/\(.+\)/, "").trim(),
                    number: index++,
                });
            } while (this.appStore.notificationList.find((it) => it.name === name));
            return name;
        },

        /**
         * Clean up modal and restore scroll behavior
         * @returns {void}
         */
        cleanupModal() {
            this.$refs.modal?.removeEventListener("shown.bs.modal", this.focusFirstInput);
            this.$refs.modal?.removeEventListener("hidden.bs.modal", this.restoreFocus);

            if (this.modal) {
                try {
                    this.modal.hide();
                } catch (e) {
                    console.warn("Modal hide failed:", e);
                }
            }
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../assets/vars.scss";

.dark {
    .modal-dialog .form-text,
    .modal-dialog p {
        color: $dark-font-color;
    }
}
</style>
