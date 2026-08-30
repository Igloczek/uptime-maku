let embeddedDatabaseTemplatePath: string | null = null;

function registerDatabaseTemplate(templatePath: string) {
    embeddedDatabaseTemplatePath = templatePath;
}

function getEmbeddedDatabaseTemplatePath() {
    if (!embeddedDatabaseTemplatePath) {
        throw new Error("Compiled database template was not registered.");
    }

    return embeddedDatabaseTemplatePath;
}

export { getEmbeddedDatabaseTemplatePath, registerDatabaseTemplate };
