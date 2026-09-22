/**
 * Place and demonym lists for the maximal sanitizer.
 *
 * Why a list at all, when there is already a "capitalised word" heuristic:
 * position. "I cook in Belgrade" is caught by a preposition cue, and "markets
 * around Karaburma" by the non-sentence-initial rule, but "Belgrade dinner
 * ideas" is sentence-initial and indistinguishable from "Quick dinner ideas" on
 * shape alone. Only knowing that Belgrade is a place separates them.
 *
 * Demonyms matter more than they look. A prompt reading "a classic Serbian
 * dinner" carries no place name, passes every positional rule, and still tells
 * the provider which country the guest is in — which is exactly how a recipe
 * answer came back opening "Since you're in Belgrade".
 *
 * This is deliberately not exhaustive and cannot be. It covers countries, their
 * demonyms, and large or capital cities: the cases where a single word pins a
 * guest to a country. A village name still gets through unless it is caught
 * positionally. Treat it as raising the floor, never as a guarantee.
 */

// Countries and territories whose names commonly appear in conversation.
const COUNTRIES = [
  'Afghanistan', 'Albania', 'Algeria', 'Andorra', 'Angola', 'Argentina', 'Armenia', 'Australia',
  'Austria', 'Azerbaijan', 'Bahrain', 'Bangladesh', 'Belarus', 'Belgium', 'Bolivia', 'Bosnia',
  'Botswana', 'Brazil', 'Bulgaria', 'Cambodia', 'Cameroon', 'Canada', 'Chile', 'China', 'Colombia',
  'Croatia', 'Cuba', 'Cyprus', 'Czechia', 'Denmark', 'Ecuador', 'Egypt', 'Estonia', 'Ethiopia',
  'Finland', 'France', 'Georgia', 'Germany', 'Ghana', 'Greece', 'Guatemala', 'Honduras', 'Hungary',
  'Iceland', 'India', 'Indonesia', 'Iran', 'Iraq', 'Ireland', 'Israel', 'Italy', 'Jamaica', 'Japan',
  'Jordan', 'Kazakhstan', 'Kenya', 'Kosovo', 'Kuwait', 'Latvia', 'Lebanon', 'Libya', 'Lithuania',
  'Luxembourg', 'Malaysia', 'Malta', 'Mexico', 'Moldova', 'Monaco', 'Mongolia', 'Montenegro',
  'Morocco', 'Mozambique', 'Myanmar', 'Namibia', 'Nepal', 'Netherlands', 'Nicaragua', 'Nigeria',
  'Norway', 'Oman', 'Pakistan', 'Palestine', 'Panama', 'Paraguay', 'Peru', 'Philippines', 'Poland',
  'Portugal', 'Qatar', 'Romania', 'Russia', 'Rwanda', 'Senegal', 'Serbia', 'Singapore', 'Slovakia',
  'Slovenia', 'Somalia', 'Spain', 'Sudan', 'Sweden', 'Switzerland', 'Syria', 'Taiwan', 'Tanzania',
  'Thailand', 'Tunisia', 'Turkey', 'Uganda', 'Ukraine', 'Uruguay', 'Uzbekistan', 'Venezuela',
  'Vietnam', 'Yemen', 'Zambia', 'Zimbabwe',
];

// Multi-word country and region names, matched before single words so
// "United Kingdom" does not degrade into two separate hits.
const MULTIWORD_PLACES = [
  'United States', 'United Kingdom', 'Great Britain', 'Northern Ireland', 'New Zealand',
  'South Africa', 'South Korea', 'North Korea', 'Saudi Arabia', 'United Arab Emirates',
  'Costa Rica', 'Dominican Republic', 'El Salvador', 'Sri Lanka', 'Hong Kong', 'North Macedonia',
  'Czech Republic', 'Ivory Coast', 'Puerto Rico', 'San Marino', 'Sierra Leone', 'South Sudan',
  'Papua New Guinea', 'Trinidad and Tobago', 'Bosnia and Herzegovina',
  // Cities whose names are two words.
  'New York', 'Los Angeles', 'San Francisco', 'San Diego', 'Las Vegas', 'New Orleans',
  'Buenos Aires', 'Rio de Janeiro', 'Sao Paulo', 'Mexico City', 'Cape Town', 'Tel Aviv',
  'Abu Dhabi', 'Kuala Lumpur', 'Ho Chi Minh', 'St Petersburg', 'Novi Sad', 'Banja Luka',
  'Frankfurt am Main', 'Den Haag', 'The Hague',
];

// Capital and large cities. Weighted toward the Balkans and Europe, because
// that is where this node's guests actually are.
const CITIES = [
  'Belgrade', 'Beograd', 'Zagreb', 'Sarajevo', 'Skopje', 'Ljubljana', 'Podgorica', 'Pristina',
  'Tirana', 'Sofia', 'Bucharest', 'Budapest', 'Vienna', 'Bratislava', 'Prague', 'Warsaw',
  'Krakow', 'Berlin', 'Munich', 'Hamburg', 'Cologne', 'Frankfurt', 'Stuttgart', 'Zurich',
  'Geneva', 'Bern', 'Paris', 'Lyon', 'Marseille', 'Madrid', 'Barcelona', 'Valencia', 'Seville',
  'Lisbon', 'Porto', 'Rome', 'Milan', 'Naples', 'Turin', 'Florence', 'Venice', 'Athens',
  'Thessaloniki', 'Istanbul', 'Ankara', 'Izmir', 'Amsterdam', 'Rotterdam', 'Brussels', 'Antwerp',
  'Copenhagen', 'Stockholm', 'Oslo', 'Helsinki', 'Reykjavik', 'Dublin', 'London', 'Manchester',
  'Birmingham', 'Liverpool', 'Glasgow', 'Edinburgh', 'Cardiff', 'Belfast', 'Moscow', 'Kyiv',
  'Kiev', 'Minsk', 'Riga', 'Vilnius', 'Tallinn', 'Chicago', 'Houston', 'Phoenix', 'Philadelphia',
  'Boston', 'Seattle', 'Denver', 'Atlanta', 'Miami', 'Dallas', 'Austin', 'Portland', 'Toronto',
  'Montreal', 'Vancouver', 'Calgary', 'Ottawa', 'Tokyo', 'Osaka', 'Kyoto', 'Seoul', 'Beijing',
  'Shanghai', 'Shenzhen', 'Guangzhou', 'Delhi', 'Mumbai', 'Bangalore', 'Chennai', 'Kolkata',
  'Karachi', 'Lahore', 'Dhaka', 'Bangkok', 'Jakarta', 'Manila', 'Hanoi', 'Sydney', 'Melbourne',
  'Brisbane', 'Perth', 'Auckland', 'Wellington', 'Cairo', 'Lagos', 'Nairobi', 'Casablanca',
  'Johannesburg', 'Durban', 'Dubai', 'Doha', 'Riyadh', 'Jeddah', 'Tehran', 'Baghdad', 'Beirut',
  'Amman', 'Jerusalem', 'Damascus', 'Lima', 'Bogota', 'Santiago', 'Caracas', 'Quito', 'Havana',
];

// Demonyms and nationality adjectives. A prompt can name no place at all and
// still pin the guest to one through these.
const DEMONYMS = [
  'Afghan', 'Albanian', 'Algerian', 'American', 'Argentine', 'Argentinian', 'Armenian',
  'Australian', 'Austrian', 'Azerbaijani', 'Bangladeshi', 'Belarusian', 'Belgian', 'Bolivian',
  'Bosnian', 'Brazilian', 'British', 'Bulgarian', 'Cambodian', 'Cameroonian', 'Canadian', 'Chilean',
  'Chinese', 'Colombian', 'Croatian', 'Cuban', 'Cypriot', 'Czech', 'Danish', 'Dutch', 'Ecuadorian',
  'Egyptian', 'English', 'Estonian', 'Ethiopian', 'Filipino', 'Finnish', 'French', 'Georgian',
  'German', 'Ghanaian', 'Greek', 'Guatemalan', 'Honduran', 'Hungarian', 'Icelandic', 'Indian',
  'Indonesian', 'Iranian', 'Iraqi', 'Irish', 'Israeli', 'Italian', 'Jamaican', 'Japanese',
  'Jordanian', 'Kazakh', 'Kenyan', 'Korean', 'Kosovar', 'Kuwaiti', 'Latvian', 'Lebanese', 'Libyan',
  'Lithuanian', 'Macedonian', 'Malaysian', 'Maltese', 'Mexican', 'Moldovan', 'Mongolian',
  'Montenegrin', 'Moroccan', 'Nepali', 'Nigerian', 'Norwegian', 'Pakistani', 'Palestinian',
  'Panamanian', 'Paraguayan', 'Peruvian', 'Polish', 'Portuguese', 'Qatari', 'Romanian', 'Russian',
  'Rwandan', 'Saudi', 'Scottish', 'Senegalese', 'Serbian', 'Singaporean', 'Slovak', 'Slovenian',
  'Somali', 'Spanish', 'Sudanese', 'Swedish', 'Swiss', 'Syrian', 'Taiwanese', 'Tanzanian', 'Thai',
  'Tunisian', 'Turkish', 'Ugandan', 'Ukrainian', 'Uruguayan', 'Uzbek', 'Venezuelan', 'Vietnamese',
  'Welsh', 'Yemeni', 'Zambian', 'Zimbabwean',
  // Regional identifiers that are just as locating as a nationality.
  'Balkan', 'Scandinavian', 'Nordic', 'Baltic', 'Iberian', 'Levantine', 'Maghrebi',
];

/**
 * Capitalised words that are ordinary English rather than proper nouns, so the
 * maximal catch-all does not redact them. Weekdays and months are included
 * deliberately: they are capitalised, extremely common, and reveal nothing on
 * their own.
 */
export const CAPITALISED_STOPWORDS = new Set([
  'I', 'A', 'An', 'The', 'This', 'That', 'These', 'Those', 'There', 'Then', 'They', 'Them',
  'It', 'Its', 'He', 'She', 'His', 'Her', 'We', 'Our', 'You', 'Your', 'My', 'Me', 'Mine',
  'What', 'When', 'Where', 'Which', 'Who', 'Whom', 'Whose', 'Why', 'How', 'Can', 'Could',
  'Would', 'Should', 'Will', 'Shall', 'May', 'Might', 'Must', 'Do', 'Does', 'Did', 'Is', 'Are',
  'Was', 'Were', 'Be', 'Been', 'Being', 'Have', 'Has', 'Had', 'Get', 'Give', 'Make', 'Take',
  'Please', 'Thanks', 'Thank', 'Hello', 'Hi', 'Hey', 'Yes', 'No', 'Not', 'And', 'But', 'Or',
  'If', 'So', 'As', 'At', 'By', 'For', 'From', 'In', 'Into', 'Of', 'On', 'To', 'With', 'Without',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December',
  'Write', 'Explain', 'Summarise', 'Summarize', 'Describe', 'List', 'Show', 'Tell', 'Help',
  'Create', 'Build', 'Generate', 'Suggest', 'Recommend', 'Compare', 'Find', 'Cook', 'Cooking',
  'Recipe', 'Dinner', 'Lunch', 'Breakfast', 'Today', 'Tomorrow', 'Tonight', 'Yesterday',
]);

/** Longest-first so multi-word entries win over their own substrings. */
const byLengthDesc = (a: string, b: string) => b.length - a.length;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One alternation of every known place name, multi-word entries first.
 *
 * Case-insensitive, and that is the point. Both of these were /g, so
 * "serbia belgrade" matched nothing while "Serbia Belgrade" matched both. Every
 * other rule at maximal strictness is also capitalisation-gated - `name`,
 * `proper_noun` and `location_generic` all require [A-Z][a-z]+ - so a prompt
 * typed in lower case, which is how a great many people type, made maximal
 * produce byte-identical output to minimal. The strictest setting silently did
 * nothing.
 *
 * A closed list is the one place this is safe to fix by dropping case: the
 * alternation only ever matches names that are on it. It does cost some false
 * positives on words that are also common nouns - "turkey", "chile", "china" -
 * which at maximal is the correct direction to fail. The shape heuristics are
 * deliberately NOT made case-insensitive: /[a-z]+ [a-z]+/i would match nearly
 * every pair of words in the language.
 */
export const PLACE_PATTERN = new RegExp(
  `\\b(?:${[...MULTIWORD_PLACES, ...COUNTRIES, ...CITIES].sort(byLengthDesc).map(escape).join('|')})\\b`,
  'gi'
);

export const DEMONYM_PATTERN = new RegExp(
  `\\b(?:${[...DEMONYMS].sort(byLengthDesc).map(escape).join('|')})\\b`,
  'gi'
);
