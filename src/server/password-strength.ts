const PASSWORD_DIVERSITY_PATTERNS = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/];
const PASSWORD_STRENGTH_LEVELS = [
    { value: "Too weak", minDiversity: 0, minLength: 0 },
    { value: "Weak", minDiversity: 2, minLength: 6 },
    { value: "Medium", minDiversity: 3, minLength: 8 },
    { value: "Strong", minDiversity: 4, minLength: 10 },
];

export function passwordStrength(password) {
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
