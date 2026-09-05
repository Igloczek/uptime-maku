<template>
    <footer class="mt-5 mb-4">
        <div class="custom-footer-text text-start">
            <strong v-if="enableEditMode">{{ $t("Custom Footer") }}:</strong>
        </div>
        <Editable
            v-if="enableEditMode"
            :model-value="footerText"
            tag="div"
            :contenteditable="enableEditMode"
            :noNL="false"
            class="alert-heading p-2"
            data-testid="custom-footer-editable"
            @update:model-value="$emit('update:footerText', $event)"
        />
        <!-- eslint-disable vue/no-v-html-->
        <div v-if="!enableEditMode" class="alert-heading p-2" data-testid="footer-text" v-html="footerHTML"></div>
        <!-- eslint-enable vue/no-v-html-->

        <p v-if="showPoweredBy" data-testid="powered-by">
            {{ $t("Powered by") }}
            <a target="_blank" rel="noopener noreferrer" href="https://github.com/iglo-tech/iglo.monitor">
                {{ $root.appName }}
            </a>
        </p>

        <div class="refresh-info mb-2">
            <div>{{ $t("lastUpdatedAt", { date: lastUpdateTimeDisplay }) }}</div>
            <div data-testid="update-countdown-text">
                {{ $t("statusPageRefreshIn", [updateCountdownText]) }}
            </div>
        </div>
    </footer>
</template>

<script>
import { sanitizeMarkdown } from "@/util/markdown-sanitize";

export default {
    props: {
        enableEditMode: {
            type: Boolean,
            default: false,
        },
        footerText: {
            type: String,
            default: "",
        },
        showPoweredBy: {
            type: Boolean,
            default: false,
        },
        lastUpdateTimeDisplay: {
            type: String,
            required: true,
        },
        updateCountdownText: {
            type: String,
            default: null,
        },
    },

    emits: ["update:footerText"],

    computed: {
        footerHTML() {
            return sanitizeMarkdown(this.footerText);
        },
    },
};
</script>

<style lang="scss" scoped>
footer {
    text-align: center;
    font-size: 14px;
}

.refresh-info {
    opacity: 0.7;
}
</style>
