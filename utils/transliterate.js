import { bankNameMappings } from "../config/banks.js";
import { slugify } from "transliteration";

export function transliterate(text) {
    if (!text) return '';
    return slugify(text, { lowercase: true, separator: '' });
}

export function findBankMapping(name) {
    // Try direct mapping first
    if (bankNameMappings[name]) {
        return bankNameMappings[name];
    }
    
    // If no mapping found, return transliterated name
    return transliterate(name);
}
