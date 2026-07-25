export async function loadDiscountRule(ruleName: string) {
  return import(`./rules/${ruleName}`);
}
