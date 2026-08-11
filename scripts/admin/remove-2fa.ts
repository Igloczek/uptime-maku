import Database from "@/server/database";
import { SQLiteStore } from "@/server/sqlite-store";
import { SQLITE_MODEL_MAPPING } from "@/server/sqlite-model-mapping";
import readline from "readline";
import TwoFA from "@/server/2fa";
import { args } from "@/server/args";

console.log("== Uptime Maku Remove 2FA Tool ==");
console.log("Loading the database");

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

const main = async () => {
    const store = new SQLiteStore({ modelMapping: SQLITE_MODEL_MAPPING });
    Database.initDataDir(args);
    await Database.connect(store);

    try {
        // No need to actually reset the password for testing, just make sure no connection problem. It is ok for now.
        if (!process.env.TEST_BACKEND) {
            const user = await store.findOne("user");
            if (!user) {
                throw new Error("user not found, have you installed?");
            }

            console.log("Found user: " + user.username);

            let ans = await question("Are you sure want to remove 2FA? [y/N]");

            if (ans.toLowerCase() === "y") {
                await TwoFA.disable2FA(store, user.id);
                console.log("2FA has been removed successfully.");
            }
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
