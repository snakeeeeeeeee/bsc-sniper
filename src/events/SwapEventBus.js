const { EventEmitter } = require('events');

class SwapEventBus extends EventEmitter {}

const swapEventBus = new SwapEventBus();

module.exports = {
    swapEventBus
};
