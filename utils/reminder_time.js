const SPAIN_TIME_ZONE = 'Europe/Madrid';
const DATE_TIME_WITHOUT_ZONE_REGEX = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const EXPLICIT_TIMEZONE_REGEX = /(Z|[+-]\d{2}:\d{2}|[+-]\d{4})$/i;

function getTimeZoneOffsetMs(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    }).formatToParts(date);

    const map = {};
    for (const part of parts) {
        if (part.type !== 'literal') {
            map[part.type] = part.value;
        }
    }

    const asUtcTimestamp = Date.UTC(
        Number(map.year),
        Number(map.month) - 1,
        Number(map.day),
        Number(map.hour),
        Number(map.minute),
        Number(map.second)
    );

    return asUtcTimestamp - date.getTime();
}

function convertSpainLocalToUtcIso(dateTimeWithoutZone) {
    const match = dateTimeWithoutZone.match(DATE_TIME_WITHOUT_ZONE_REGEX);
    if (!match) {
        return null;
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6] || '0');

    const localAsUtcTimestamp = Date.UTC(year, month - 1, day, hour, minute, second);
    let utcTimestamp = localAsUtcTimestamp;

    for (let i = 0; i < 3; i += 1) {
        const offsetMs = getTimeZoneOffsetMs(new Date(utcTimestamp), SPAIN_TIME_ZONE);
        utcTimestamp = localAsUtcTimestamp - offsetMs;
    }

    return new Date(utcTimestamp).toISOString();
}

function parseReminderDateTimeInput(value) {
    if (typeof value !== 'string' || !value.trim()) {
        return null;
    }

    const input = value.trim();
    if (EXPLICIT_TIMEZONE_REGEX.test(input)) {
        const parsed = new Date(input);
        if (Number.isNaN(parsed.getTime())) {
            return null;
        }
        return parsed.toISOString();
    }

    return convertSpainLocalToUtcIso(input);
}

module.exports = {
    SPAIN_TIME_ZONE,
    parseReminderDateTimeInput
};
