const { validate: validateOrder } = require("./validation");

function submitOrder() {
  return validateOrder();
}

module.exports = { submitOrder };
