const MONTH_NAMES = require('../data/month_names');


exports.formatUnixDate = function (unix) {
  const date = new Date(unix*1000);
  if (isNaN(date)) {
    return '';
  } else {
    const month = MONTH_NAMES[date.getMonth()];
    const day = date.getDate();
    const year = date.getFullYear();
    return `${month} ${day}, ${year}`;
  }
};