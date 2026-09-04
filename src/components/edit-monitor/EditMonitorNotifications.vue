<template>
    <h2 class="mb-2">{{ $t("Notifications") }}</h2>
    <p v-if="$root.notificationList.length === 0">
        {{ $t("Not available, please setup.") }}
    </p>
    <div v-for="notification in $root.notificationList" :key="notification.id" class="form-check form-switch my-3">
        <input
            :id="'notification' + notification.id"
            v-model="monitor.notificationIDList[notification.id]"
            class="form-check-input"
            type="checkbox"
        />
        <label class="form-check-label" :for="'notification' + notification.id">
            {{ notification.name }}
            <a href="#" @click.prevent="$emit('edit-notification', notification.id)">
                {{ $t("Edit") }}
            </a>
        </label>
        <span v-if="notification.isDefault == true" class="badge bg-primary ms-2">
            {{ $t("Default") }}
        </span>
    </div>
    <button class="btn btn-primary me-2" type="button" @click="$emit('setup-notification')">
        {{ $t("Setup Notification") }}
    </button>
</template>

<script>
export default {
    name: "EditMonitorNotifications",

    props: {
        monitor: {
            type: Object,
            required: true,
        },
    },

    emits: ["setup-notification", "edit-notification"],
};
</script>
