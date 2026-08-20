import Database from "@/server/database";
import { SQLiteStore } from "@/server/sqlite-store";
import { SQLITE_MODEL_MAPPING } from "@/server/sqlite-model-mapping";
import readline from "readline";

import { initJWTSecret } from "@/server/server-auth-helpers";
import User from "@/server/model/user";
import { args } from "@/server/args";

const PASSWORD_DIVERSITY_PATTERNS = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/];
const PASSWORD_STRENGTH_LEVELS = [
    { value: "Too weak", minDiversity: 0, minLength: 0 },
    { value: "Weak", minDiversity: 2, minLength: 6 },
    { value: "Medium", minDiversity: 3, minLength: 8 },
    { value: "Strong", minDiversity: 4, minLength: 10 },
];

function passwordStrength(password) {
    let diversity = 0;
    for (const pattern of PASSWORD_DIVERSITY_PATTERNS) {
        if (pattern.test(password)) {
            diversity++;
        }
    }

    let value = "Too weak";
    for (const level of PASSWORD_STRENGTH_LEVELS) {
        if (diversity >= level.minDiversity && password.length >= level.minLength) {
            value = level.value;
        }
    }

    return { value };
}

console.log("== Uptime Maku Reset Password Tool ==");

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

const main = async () => {
    const store = new SQLiteStore({ modelMapping: SQLITE_MODEL_MAPPING });
    if ("dry-run" in args) {
        console.log("Dry run mode, no changes will be made.");
    }

    console.log("Connecting the database");

    try {
        Database.initDataDir(args);
        await Database.connect(store, false, true);
        // No need to actually reset the password for testing, just make sure no connection problem. It is ok for now.
        if (!process.env.TEST_BACKEND) {
            const user = await store.findOne("user");
            if (!user) {
                throw new Error("user not found, have you installed?");
            }

            console.log("Found user: " + user.username);

            while (true) {
                let password;
                let confirmPassword;

                // When called with "--new-password" argument for unattended modification.
                if ("new-password" in args) {
                    console.log("Using password from argument");
                    console.warn(
                        "\x1b[31m%s\x1b[0m",
                        "Warning: the password might be stored, in plain text, in your shell's history"
                    );
                    password = confirmPassword = args["new-password"] + "";
                    if (passwordStrength(password).value === "Too weak") {
                        throw new Error("Password is too weak, please use a stronger password.");
                    }
                } else {
                    password = await question("New Password: ");
                    if (passwordStrength(password).value === "Too weak") {
                        console.log("Password is too weak, please try again.");
                        continue;
                    }
                    confirmPassword = await question("Confirm New Password: ");
                }

                if (password === confirmPassword) {
                    if (!("dry-run" in args)) {
                        await User.resetPassword(store, user.id, password);

                        // Reset all sessions by reset jwt secret
                        await initJWTSecret(store);

                        console.warn(
                            "JWT secret was reset. Restart the server to disconnect active WebSocket sessions."
                        );
                    }
                    break;
                } else {
                    console.log("Passwords do not match, please try again.");
                }
            }
            console.log("Password reset successfully.");
        }
    } catch (e) {
        console.error("Error: " + e.message);
    }

    await Database.close(store);
    rl.close();

    console.log("Finished.");
};

/**
 * Ask question of user
 * @param {string} question Question to ask
 * @returns {Promise<string>} Users response
 */
function question(question) {
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            resolve(answer);
        });
    });
}

if (!process.env.TEST_BACKEND) {
    main();
}

export { main };
