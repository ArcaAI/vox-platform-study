"""Word pools for the synthetic generator. Data only; no logic.

Names are Latin-script, Kerala-flavoured plus a minority of Western ones. Surnames and
first names that are also ordinary English words (Mini, Frank, Young, Hall, ...) are left
out on purpose: the gold must not contain a string that also occurs as a plain word in
the filler text, or the verbatim-survival check would count an innocent word as a leak.
Eponyms used as hard negatives (Parkinson, Addison, ...) are never person names here.
"""

from __future__ import annotations

FIRST_ML_M = (
    "Anil Sreejith Vineeth Biju Sajeev Rajesh Manoj Prasad Unnikrishnan Harikumar Jayakumar "
    "Abhilash Arun Ajith Shibu Rakesh Dileep Santhosh Mohanan Gopakumar Baburaj Jose Kuriakose "
    "Shaji Noushad Faisal Basheer Sudheesh Nidhin Jithin Akhil Vishnu Anoop Renjith Sanjay "
    "Krishnankutty Sivadasan Ramachandran Pradeep Suresh Binoy Tomy Libin"
).split()
FIRST_ML_F = (
    "Remya Lakshmi Anjana Jisha Shalini Divya Sreelekha Aswathy Athira Neethu Bindu Sindhu "
    "Latha Geetha Resmi Reshma Sherin Anitha Smitha Deepa Sunitha Rajani Sheeja Nisha Fathima "
    "Jameela Shamsiya Rosamma Elsy Annamma Parvathy Sreedevi Vasanthi Sobha Meera Thankamma "
    "Kamalamma Jincy Dhanya Bhavana"
).split()
FIRST_WEST = (
    "James Olivia Liam Emma Noah Ava Ethan Sophia Daniel Hannah Henry Chloe Oliver Amelia "
    "Samuel Robert Linda George Susan Peter Helen Paul Alice Edward Megan"
).split()
LAST_ML = (
    "Nair Menon Pillai Kurup Warrier Namboothiri Panicker Varma Kumar Thomas Mathew Varghese "
    "Joseph Kurian Philip Abraham Ibrahim Hussain Rahman Nambiar Iyer Chacko Antony Sebastian "
    "Mohammed Krishnan Gopalan Sreedharan Kaimal Marar Poduval Thampi Unnithan Vaidyan Koshy "
    "Cherian Eapen Pisharody"
).split()
LAST_WEST = (
    "Smith Johnson Brown Taylor Anderson Clark Walker Wright Scott Adams Nelson Carter "
    "Mitchell Parker Collins Murphy Bailey Rivera Cooper Foster Hughes Morgan Bennett"
).split()

EMAIL_DOMAINS = ("gmail.com", "yahoo.co.in", "rediffmail.com", "outlook.com", "hotmail.com")
URL_HOSTS = ("myhealth.carepoint-demo.in", "portal.asterdemo.org", "records.kimsdemo.co.in")

CITIES_IN = (
    "Kochi",
    "Thiruvananthapuram",
    "Kozhikode",
    "Thrissur",
    "Kollam",
    "Kannur",
    "Palakkad",
    "Alappuzha",
)
STREETS_IN = (
    "MG Road",
    "Temple Road",
    "Church Lane",
    "Palace Road",
    "Market Road",
    "Beach Road",
    "Convent Road",
    "Station Road",
    "Kaloor Road",
    "Vyttila Road",
)
BUILDINGS_IN = (
    "Sree Residency",
    "Pushpa Nivas",
    "Karthika",
    "Anugraha",
    "Green Villa",
    "Haritha Apartments",
    "Ayyappa Nilayam",
)
STREETS_WEST = (
    "Maple Street",
    "Oak Avenue",
    "Lakeview Drive",
    "Cedar Lane",
    "Highland Road",
    "Elm Court",
)
CITIES_WEST = ("Springfield", "Riverton", "Fairview", "Lakeside", "Brookfield")

DISEASES = (
    "Parkinson's disease",
    "Bell's palsy",
    "Hodgkin lymphoma",
    "Addison's disease",
    "Crohn's disease",
    "Alzheimer's disease",
    "Graves' disease",
    "Hashimoto thyroiditis",
    "Cushing syndrome",
    "Raynaud's phenomenon",
    "Huntington's disease",
    "Paget's disease",
    "Guillain-Barre syndrome",
    "Kawasaki disease",
    "Marfan syndrome",
    "Wilson's disease",
    "Meniere's disease",
    "Sjogren's syndrome",
    "Hirschsprung disease",
    "Tourette syndrome",
    "Dupuytren's contracture",
    "Barrett's oesophagus",
)
ANATOMY = (
    "Achilles tendon",
    "Fallopian tube",
    "Eustachian tube",
    "islets of Langerhans",
    "circle of Willis",
    "bundle of His",
    "Sylvian fissure",
    "Broca's area",
    "pouch of Douglas",
    "loop of Henle",
    "Bartholin's gland",
    "ampulla of Vater",
    "Wharton's duct",
)
DRUGS = (
    "Augmentin",
    "Pantoprazole",
    "Glimepiride",
    "Amlodipine",
    "Ciplox",
    "Dolo",
    "Telma",
    "Metformin",
    "Atorvastatin",
    "Ecosprin",
    "Zerodol",
    "Montair",
    "Amaryl",
    "Januvia",
    "Lasix",
    "Zantac",
    "Ramipril",
    "Losartan",
)
DOSES = (
    "500 mg",
    "10 units",
    "0.25 mg",
    "2.5 mg",
    "650 mg",
    "1 tablet",
    "20 mg",
    "75 mg",
    "5 ml",
    "100 mg",
)
VITALS = (
    "130/85 mmHg",
    "72 bpm",
    "98.6 F",
    "7.2 percent",
    "36.8 C",
    "142/90 mmHg",
    "96 percent",
    "5.4 mmol/L",
)
RELATIONS = (
    ("wife", "bharya"),
    ("husband", "bharthavu"),
    ("son", "makan"),
    ("daughter", "makal"),
    ("mother", "amma"),
    ("father", "achan"),
    ("brother", "sahodaran"),
)
SYMPTOMS_ML = (
    "thalavedana",
    "chuma",
    "vayaru vedana",
    "kaal vedana",
    "nenju vedana",
    "pani",
    "kazhuthu vedana",
)
MONTHS = (
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)
NUMBER_WORDS = {
    2: "two",
    3: "three",
    4: "four",
    5: "five",
    6: "six",
    7: "seven",
    10: "ten",
    14: "fourteen",
}
ML_NUMBERS = {
    2: "randu",
    3: "moonu",
    4: "naalu",
    5: "anchu",
    6: "aaru",
    7: "ezhu",
    10: "pathu",
    14: "pathinaalu",
}
ML_UNITS = ("divasam", "aazhcha", "masam")
EN_UNITS = ("days", "weeks", "months")

#: Neutral clinical turns with no identifier, no number-as-ID and no proper noun. Used only
#: when no real skeleton (ACI-bench / golden set) is available, and by the unit tests.
BUILTIN_SKELETON = (
    ("Doctor", "What brings you in today?"),
    ("Patient", "I have been feeling tired and my chest feels tight when I walk uphill."),
    ("Doctor", "Does the tightness spread to your arm or your jaw?"),
    ("Patient", "No, it stays in the middle of my chest and goes away when I rest."),
    ("Doctor", "Any shortness of breath, sweating or nausea with it?"),
    ("Patient", "A little breathless on the stairs, but no sweating."),
    ("Doctor", "Have you had a fever, a cough or any weight loss recently?"),
    ("Patient", "No fever. A dry cough in the mornings, nothing else."),
    ("Doctor", "Are you taking your tablets regularly?"),
    ("Patient", "Yes, I take them every morning after breakfast."),
    ("Doctor", "Let me listen to your heart and lungs now."),
    ("Doctor", "Your heart sounds regular and the lungs are clear."),
    ("Patient", "That is a relief. I was worried it was something serious."),
    ("Doctor", "I would like to do an ECG and a few blood tests today."),
    ("Patient", "Will I need to fast for the blood tests?"),
    ("Doctor", "Not for these, you can eat normally."),
    ("Doctor", "Do you smoke or drink alcohol?"),
    ("Patient", "I stopped smoking some years ago and I do not drink."),
    ("Doctor", "That is good. Keep walking daily, but stop if the tightness returns."),
    ("Patient", "Should I avoid spicy food as well?"),
    ("Doctor", "A lighter evening meal usually helps with the discomfort."),
    ("Patient", "My sleep has been poor and I wake up several times at night."),
    ("Doctor", "We will look at that too. Try to keep a regular bedtime."),
    ("Doctor", "I will also check your blood sugar and your kidney function."),
    ("Patient", "Is there anything I should watch out for at home?"),
    ("Doctor", "If the pain lasts more than ten minutes, come to the emergency department."),
    ("Patient", "Understood. And if it gets better, should I still come back?"),
    ("Doctor", "Yes, a review once the results are ready would be sensible."),
    ("Doctor", "The swelling in your ankles has settled since the last visit."),
    ("Patient", "Yes, I have been keeping my feet up in the evenings."),
    ("Doctor", "Any dizziness when you stand up quickly?"),
    ("Patient", "Sometimes, mostly first thing in the morning."),
    ("Doctor", "Drink plenty of water and get up slowly from bed."),
    ("Patient", "I will try that. Thank you for explaining everything."),
    ("Doctor", "You are welcome. Please ask the nurse if you have any questions."),
    ("Doctor", "Let us go through the plan once more so it is clear."),
    ("Patient", "The headaches come in the afternoon and ease after a rest."),
    ("Doctor", "Have you noticed any change in your vision with them?"),
    ("Patient", "No, my vision is fine."),
    ("Doctor", "Good. We will start with simple measures and review how you respond."),
)
MANGLISH_FILLER = (
    ("Patient", "Doctor, enikku rathri chuma koodunnu."),
    ("Patient", "Bhakshanam kazhichathinu shesham vayaru vedana und."),
    ("Patient", "Tablet kazhichittum maattam illa doctor."),
    ("Patient", "Pani illa, pakshe sareeram muzhuvan vedana."),
    ("Patient", "Urakkam kuravaanu doctor, rathri pala pravishyam ezhunnelkkum."),
    ("Doctor", "Blood pressure nokkaan arm onnu neettu."),
    ("Doctor", "Sugar level check cheyyam, ottum pedikkanda."),
    ("Patient", "Okay doctor, njan tablet kazhikkam."),
    ("Patient", "Ee report onnu nokku doctor."),
    ("Doctor", "Venamenkil scan edukkam, ippol vishamikkanda."),
    ("Doctor", "Randu aazhcha kazhinju veendum vaa."),
    ("Patient", "Chaya kudikkunnathu kurachittundu doctor."),
)
NOTE_SENTENCES = (
    "Examination unremarkable apart from mild tenderness on palpation.",
    "Chest clear on auscultation, heart sounds regular.",
    "Advised rest, hydration and a light diet.",
    "No red-flag symptoms reported at this visit.",
    "Bloods and ECG requested; review when results are available.",
    "Counselled on warning signs and when to seek urgent care.",
    "Medication list reconciled and allergies confirmed as none known.",
)
