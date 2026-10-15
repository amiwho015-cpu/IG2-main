"use strict";

/**
 * Gender helper for the pair commands.
 * Instagram does not expose gender, so it is resolved in this order:
 *   1. a value set by hand with the `gender` command (always wins),
 *   2. a guess from the display name / username (common Bangla + English names),
 *   3. unknown (0) — pair never treats unknown as a match for the same gender.
 * 1 = boy, 2 = girl, 0 = unknown.
 */

const GIRL = new Set(`aisha ayesha ayesa afia afrin afroza akhi alisha amena anika anila anjali anika antora anushka arifa arpita asma auntora bristy bithi bipasha borsha chandni chaiti dina disha dipa dipti eshita eva farhana farzana fahmida fariha farjana fatema fatima habiba hafsa halima hasina hira humaira israt jahanara jannat jannatul jarin jesmin joya jui jhumur kabita kajol kakoli kamrun keya khadija khushi konika laboni laila lamia lima liza lubna maria mariam marzia mahi mahiya maliha mim mimi mithila moni monira mou moushumi mukta munia mysha nabila nadia nafisa nahar naima najma nasrin nazia nazma nila nipa nishat nishi nodi nowrin nupur nusrat oishi orpa papiya parvin payel peya pori poly puja puspita rabeya rabiya rafia rahima raisa rakhi rani rawnak razia rehana rekha rima rimi riya roksana rokeya ruma rumana rumi runa sabina sabrina sadia sadiya safa sahana sahida salma samia sanjida sara sarah sathi shabnam shahana shahnaz shamima shanta sharmin shathi shilpi shirin shompa shornali shuvra sifat simi sima sneha sonia sraboni sumaiya sumi sumona sunita sultana tahmina tamanna tania tanjila tanni tanzila taslima tasnim tithi tisha toma tonni tuli tuhin_a urmi zakia zannat zarin zinia zoya zahra`.split(/\s+/));

const BOY = new Set(`abdul abdullah abir abu adnan afsar ahmed akash akib alamin ali amir anik anis ariful arif arman asif ashik ashraf babu bappy bashar biplob bipul chanchal dipu emon enam faisal fahim fahad farhan faruk fuad habib hasan hassan helal hossain hridoy ibrahim ikbal imran imtiaz ismail jahid jamal jashim jewel joy jubayer junaid kabir kamal karim khalid kibria mahbub mahin mahfuz mahmud mamun masud mehedi mizan mohammad mohammed mohsin monir mostafa muhammad mukit munna nabil nahid naim nayeem nazmul nasir nayan nizam noman nur omar parvez piyas rabbi rafi rafiq rahat rahim rahman raihan rajib rakib ramim rana rashed rasel rashid rayhan razu redwan reza riad rifat rifat rony rubel rubel ruhul sabbir sadman saiful sajid sakib salman samim sami sanjoy sayed shahin shahriar shakil shamim shanto shihab shohag shohel shuvo siam sohag sohel sourav sumon sumit tahmid tamim tanvir tareq taskin tawhid tonmoy touhid tushar ullash uzzal wasim yasin yeasin zahid zakir zihad zubayer`.split(/\s+/));

function tokens(...parts) {
	return parts.filter(Boolean).join(" ").toLowerCase()
		.replace(/[^a-zঀ-৿\s._-]/g, " ").split(/[\s._-]+/).filter(t => t.length > 2);
}

/** 1 boy, 2 girl, 0 unknown, from names only. */
function guessFromName(name, username) {
	let girl = 0, boy = 0;
	for (const t of tokens(name, username)) {
		if (GIRL.has(t)) girl += 2;
		if (BOY.has(t)) boy += 2;
		// weaker signals: very common female endings that are rare for male names
		if (/(ia|ika|ina|ima|ita|ini|ela|ana)$/.test(t) && !BOY.has(t)) girl += 1;
	}
	// "binte / begum / khatun / akter / sultana / jahan" are female name parts.
	if (/\b(binte|begum|khatun|akter|akhter|jahan|rani|devi)\b/i.test(String(name || ""))) girl += 3;
	if (/\b(md|mohammad|muhammad|mohd|sheikh|mir)\b/i.test(String(name || ""))) boy += 1;
	if (girl > boy) return 2;
	if (boy > girl) return 1;
	return 0;
}

async function resolveGender(usersData, uid) {
	let rec = {};
	try { rec = (await usersData.get(uid)) || {}; } catch (_) { /* ignore */ }
	if (rec.gender === 1 || rec.gender === 2) return { gender: rec.gender, name: rec.name || null, manual: true };
	let name = rec.name || null;
	if (!name) { try { name = await usersData.getName(uid); } catch (_) { /* ignore */ } }
	return { gender: guessFromName(name, rec.username), name, manual: false };
}

/**
 * Pick an opposite-gender partner from `members`.
 * Never returns someone of the same known gender. Throws a friendly Error when
 * nobody can be identified as the opposite gender.
 */
async function pickPartner(usersData, targetID, members, wanted) {
	const me = await resolveGender(usersData, targetID);
	const pool = [];
	for (const uid of members.sort(() => Math.random() - 0.5)) {
		const g = await resolveGender(usersData, uid);
		pool.push({ id: uid, name: g.name || `User ${uid}`, gender: g.gender });
	}
	let myGender = wanted === "boy" ? 1 : wanted === "girl" ? 2 : me.gender;
	const opposite = myGender === 1 ? 2 : myGender === 2 ? 1 : 0;

	if (!myGender) {
		const err = new Error("I can't tell your gender. Use `gender boy` or `gender girl` once, then try again.");
		err.friendly = true; throw err;
	}
	const exact = pool.filter(p => p.gender === opposite);
	if (exact.length) return { me: { id: targetID, name: me.name || "User", gender: myGender }, partner: exact[0] };

	const err = new Error(`No ${opposite === 2 ? "girl" : "boy"} could be identified in this group. Members can tag themselves with \`gender ${opposite === 2 ? "girl" : "boy"}\` (admins can reply to someone's message with it).`);
	err.friendly = true; throw err;
}

/**
 * For couple-image commands (kiss, hug, propose): decide whether the sender
 * takes the boy's spot (true) or the girl's spot (false) in the template.
 * Uses the same gender data as pair (manual `gender` setting, then name guess).
 * The sender's own gender wins; if unknown, the opposite of the target's;
 * if both unknown, the sender takes the boy's spot.
 */
async function assignSpots(usersData, senderID, targetID) {
	const s = await resolveGender(usersData, String(senderID));
	if (s.gender === 1) return true;
	if (s.gender === 2) return false;
	const t = await resolveGender(usersData, String(targetID));
	if (t.gender === 1) return false;
	if (t.gender === 2) return true;
	return true;
}

module.exports = { guessFromName, resolveGender, pickPartner, assignSpots };
