export const seriesUk = {
  "Analysis mode": "Режим аналізу",
  "Compare individual tests": "Порівняння окремих випробувань",
  "Batch / series variation": "Відхилення партії / серії",
  "Series name": "Назва серії",
  "Add a folder of CSV logs": "Додати папку з логами CSV",
  "Spread band": "Діапазон відхилень",
  "Mean ± standard deviation": "Середнє ± стандартне відхилення",
  "Minimum–maximum": "Мінімум–максимум",
  "Show individual profiles": "Показати окремі профілі",
  "About series analysis": "Про аналіз серії",
  "Every included, complete test has equal weight, regardless of sample rate. The band shows test-to-test spread, not a confidence interval or an acceptance tolerance. Curves use only the common aligned burn interval. Scalar metrics always retain original source time. Exclude a test explicitly to remove it from statistics; hiding its trace does not exclude it.":
    "Кожне включене випробування з повними даними має однакову вагу незалежно від частоти запису. Смуга показує розкид між випробуваннями, а не довірчий інтервал чи допустимі межі. Криві охоплюють лише спільний суміщений інтервал горіння. Показники завжди розраховуються за початковим часом CSV. Щоб прибрати випробування зі статистики, виключіть його явно; приховування кривої не виключає дані.",
  "Series repeatability": "Повторюваність серії",
  "Export series report CSV": "Зберегти звіт серії CSV",
  "At least two tests are needed for standard deviation; potential outliers are marked from five tests. Small samples need careful interpretation.":
    "Для стандартного відхилення потрібно щонайменше два випробування; потенційні викиди позначаються від п’яти. Результати малих вибірок слід оцінювати обережно.",
  "Series summary": "Підсумок серії",
  "Test deviations": "Відхилення випробувань",
  "Deviation metric": "Показник для порівняння",
  "About potential outliers": "Про потенційні викиди",
  "Potential outliers fall outside Q1 − 1.5 × IQR or Q3 + 1.5 × IQR, with at least five eligible values. Quartiles use linear interpolation. Flags suggest review, not failure, and never remove tests automatically. Standard deviation uses n − 1; coefficient of variation is SD / |mean| × 100% and is unavailable near zero mean.":
    "Потенційні викиди лежать нижче Q1 − 1,5 × IQR або вище Q3 + 1,5 × IQR за наявності щонайменше п’яти придатних значень. Квартилі визначаються лінійною інтерполяцією. Позначка пропонує перевірити дані, не означає невдале випробування й ніколи не виключає його автоматично. Стандартне відхилення розраховується з дільником n − 1. Коефіцієнт варіації: SD / |середнє| × 100%; він недоступний, коли середнє близьке до нуля.",
  "Include in series statistics": "Враховувати у статистиці серії",
  "Mean pressure": "Середній тиск",
  "{eligible} of {included} included tests are eligible":
    "Придатних випробувань: {eligible} із {included} включених",
  Metric: "Показник",
  "Tests (n)": "Випробувань (n)",
  "Series mean": "Середнє серії",
  "Sample standard deviation": "Стандартне відхилення вибірки",
  "Coefficient of variation": "Коефіцієнт варіації",
  Minimum: "Мінімум",
  Maximum: "Максимум",
  Value: "Значення",
  "Difference from mean": "Різниця із середнім",
  "Deviation (%)": "Відхилення (%)",
  "Standard score (z)": "Стандартизована оцінка (z)",
  "Series status": "Статус у серії",
  "Excluded by user": "Виключено користувачем",
  "This metric is unavailable": "Цей показник недоступний",
  "Potential outlier · review": "Потенційний викид · перевірте",
  Included: "Включено",
  "Raw measurements are unavailable for this test.":
    "Початкові вимірювання цього випробування недоступні.",
  "Set valid ignition and burnout events to include this test in series statistics.":
    "Укажіть коректні межі початку й кінця горіння, щоб включити випробування у статистику серії.",
  "Missing data in the selected burn excludes this test from series statistics.":
    "Пропуски даних у вибраному інтервалі горіння виключають випробування зі статистики серії.",
  "Correct invalid test settings to include it in series statistics.":
    "Виправте некоректні налаштування випробування, щоб включити його у статистику серії.",
  "Series mean and spread": "Середній профіль і розкид серії",
  "Deviations from series mean": "Відхилення від середнього профілю",
  "Series spread around mean": "Розкид серії відносно середнього",
  "No common eligible burn interval. Review events or align ignition or both events.":
    "Немає спільного інтервалу горіння з придатними даними. Перевірте межі або сумістіть початки горіння чи обидві межі.",
  "Add a series of CSV logs and review the burn events.":
    "Додайте серію логів CSV та перевірте межі горіння.",
  "The selected folder contains no CSV, TSV, or TXT logs.":
    "У вибраній папці немає логів CSV, TSV або TXT.",
  "Each visible test is compared with the equal-weight series mean on the common aligned burn interval. The band is spread between tests, not an acceptance limit. Curves are display approximations; report metrics use original selected-interval values.":
    "Кожне видиме випробування порівнюється із середнім профілем серії на спільному суміщеному інтервалі горіння. Усі придатні випробування мають однакову вагу. Смуга показує розкид між випробуваннями, а не допустимі межі. Криві є наближеним відображенням; показники звіту розраховуються за початковими значеннями на вибраному інтервалі.",
};
