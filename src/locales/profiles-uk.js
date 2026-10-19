export const profilesUk = {
  "Set reference": "Зробити базовим",
  Workspace: "Робочий простір",
  "Burn profile analysis": "Аналіз профілів горіння",
  "Add CSV logs, align burn events, and compare measurements.":
    "Додайте логи CSV, сумістіть початок і кінець горіння та порівняйте вимірювання.",
  "Compare examples": "Порівняти приклади",
  "Add CSV logs": "Додати логи CSV",
  Profiles: "Профілі",
  "Clear all": "Очистити все",
  "Import format": "Формат імпорту",
  "Applies to new files. Existing profiles have their own source units.":
    "Для нових файлів. Одиниці вже доданих профілів налаштовуються окремо.",
  "Drop multiple CSV files here": "Перетягніть сюди файли CSV",
  "Up to 12 logs · local processing only": "До 12 логів · обробка на вашому пристрої",
  "Reference profile": "Базовий профіль",
  "Align profiles": "Суміщення профілів",
  "Ignition at zero": "Початок горіння в нулі",
  "Burnout at zero": "Кінець горіння в нулі",
  "Both events · 0–100%": "Початок і кінець · 0–100%",
  Signal: "Показник",
  "Chart view": "Вигляд графіка",
  "Raw measurements": "Початкові вимірювання",
  "Moving mean": "Ковзне середнє",
  "Trend residual": "Відхилення від тренду",
  "Detection and noise settings": "Визначення горіння й аналіз шуму",
  "Burn threshold (% of peak)": "Поріг горіння (% від піку)",
  "Moving window (ms)": "Вікно усереднення (мс)",
  "About profile calculations": "Про розрахунок профілів",
  "Events use the first rise and final decay through the threshold. Noise is the time-weighted RMS residual from a centered moving mean, over the middle 80% of the selected burn unless you set a custom interval. It includes real signal fluctuations and is not calibrated sensor uncertainty. Missing intervals are never bridged.":
    "Межі горіння визначаються за першим підйомом і останнім спадом тяги через заданий поріг. Шум — це середньоквадратичне відхилення від центрованого ковзного середнього з урахуванням тривалості. Типово розрахунок охоплює середні 80% горіння; можна вибрати інший інтервал. Він включає справжні коливання сигналу й не є каліброваною оцінкою невизначеності датчика. Пропуски не з’єднуються.",
  Cancel: "Скасувати",
  "Profile overlay": "Суміщені профілі",
  "About profile alignment": "Про суміщення профілів",
  "Ignition and burnout alignment shift only the display clock. Both events maps each selected burn to 0–100% for shape comparison. Original durations, impulse, and specific impulse remain unchanged. Drag A/B markers or use the event fields to refine boundaries. Zoom with the wheel, drag to pan, and double-click to fit.":
    "Суміщення за початком або кінцем горіння змінює лише відлік часу на графіку. Режим «Початок і кінець» відображає кожне горіння на шкалі 0–100% для порівняння форми. Початкові тривалості, імпульс і питомий імпульс зберігаються. Уточнюйте межі маркерами A/B або полями часу. Коліщатко змінює масштаб, перетягування пересуває графік, подвійне клацання показує всі профілі.",
  "Fit profiles": "Усі профілі",
  "Compared burn profiles": "Профілі горіння для порівняння",
  "Compare your burn profiles": "Порівняйте профілі горіння",
  "Add two or more CSV logs. No video is required.":
    "Додайте щонайменше два логи CSV. Відео не потрібне.",
  "Difference from reference": "Різниця з базовим профілем",
  "About profile differences": "Про різницю між профілями",
  "Candidate minus reference, using raw measurements on the common selected burn interval. RMSE and mean error are time-weighted. Only overlapping valid data contributes; gaps and unsupported extrapolation stay empty. The normalized view compares burn phase, without changing the original metrics.":
    "Від початкових вимірювань профілю віднімаються вимірювання базового на спільному вибраному інтервалі горіння. RMSE та середня різниця враховують тривалість. Використовуються лише ділянки з даними в обох логах; пропуски й ділянки без перекриття залишаються порожніми. Нормалізований вигляд порівнює фази горіння, зберігаючи початкові показники.",
  "Raw data · common selected interval": "Початкові дані · спільний вибраний інтервал",
  "Difference between burn profiles": "Різниця між профілями горіння",
  "Comparison results": "Результати порівняння",
  "About specific impulse": "Про питомий імпульс",
  "Results use original CSV seconds over the selected burn interval. Impulse integrates positive thrust; means use valid measured time. Specific impulse is I/(m × 9.80665), using consumed propellant mass in kg. It is unavailable without mass or with missing intervals. Thrust and pressure alone do not determine thermal efficiency.":
    "Результати розраховуються за часом у секундах із CSV на вибраному інтервалі горіння. Імпульс — інтеграл додатної тяги; середні значення враховують лише час із даними. Питомий імпульс: I/(m × 9,80665), де m — маса витраченого палива в кг. Він недоступний без маси або за наявності пропусків. Лише за тягою й тиском тепловий ККД визначити неможливо.",
  "Original time · selected burn interval": "Час із CSV · вибраний інтервал горіння",
  "Export comparison CSV": "Зберегти порівняння CSV",
  "Metrics appear after importing a CSV log.":
    "Показники з’являться після додавання логу CSV.",
  "Calculation notes": "Методика розрахунку",
  "This workspace compares measurements; it does not correct calibration or infer missing samples. Review detected events and source units before comparing. Noise residual depends on the moving-window width and selected interval. Unequal sample rates are compared by time, not by row number.":
    "Інструмент порівнює вимірювання, не змінює калібрування й не відновлює пропущені відліки. Перед порівнянням перевірте визначені межі горіння та вхідні одиниці. Залишковий шум залежить від ширини вікна усереднення й вибраного інтервалу. Логи з різною частотою запису суміщаються за часом, а не за номером рядка.",
  "Specific impulse methodology · NASA": "Методика питомого імпульсу · NASA",
  Reference: "Базовий",
  "Remove profile": "Видалити профіль",
  "Ignition (s)": "Початок горіння (с)",
  "Pick ignition on chart": "Вибрати початок горіння на графіку",
  "Burnout (s)": "Кінець горіння (с)",
  "Pick burnout on chart": "Вибрати кінець горіння на графіку",
  "Consumed propellant (g)": "Витрачене паливо (г)",
  Optional: "Необов’язково",
  "Source units and noise interval": "Вхідні одиниці й інтервал шуму",
  "Noise from (s)": "Шум від (с)",
  Automatic: "Автоматично",
  "Noise to (s)": "Шум до (с)",
  "Choose ignition before burnout, with both events inside the CSV time range.":
    "Укажіть початок раніше за кінець горіння, обидві межі — у часовому діапазоні CSV.",
  "Propellant mass must be a positive number in kilograms.":
    "Маса палива має бути додатним числом у кілограмах.",
  "The noise moving window must be a positive number of seconds.":
    "Вікно усереднення шуму має бути додатним числом секунд.",
  "Choose a noise interval with its start before its end, inside the CSV time range.":
    "Виберіть інтервал шуму в часовому діапазоні CSV: початок має бути раніше за кінець.",
  "Set both ignition and burnout events to calculate burn statistics.":
    "Укажіть початок і кінець горіння, щоб розрахувати показники.",
  "The selected burn interval contains missing data. Integrals and means use only covered intervals; specific impulse is unavailable.":
    "У вибраному інтервалі горіння є пропуски. Інтеграли й середні враховують лише ділянки з даними; питомий імпульс недоступний.",
  "Noise cannot be estimated: no complete moving window lies inside the selected noise interval.":
    "Шум неможливо оцінити: у вибраному інтервалі немає повного вікна усереднення з даними.",
  "Noise is residual variation around a moving mean, including real combustion changes and measurement noise; it is not calibrated uncertainty.":
    "Шум — це залишкові коливання відносно ковзного середнього, зокрема справжні зміни горіння й шум вимірювання. Він не є каліброваною оцінкою невизначеності.",
  "Unknown profile alignment mode.": "Невідомий режим суміщення профілів.",
  "Profile alignment must have a finite offset and a positive scale.":
    "Суміщення профілів потребує скінченного зміщення й додатного масштабу.",
  Profile: "Профіль",
  "Burn duration": "Тривалість горіння",
  "Total impulse": "Повний імпульс",
  "Mean thrust": "Середня тяга",
  "Peak thrust": "Максимальна тяга",
  "Peak pressure": "Максимальний тиск",
  "Thrust residual RMS": "СКЗ залишкової тяги",
  "Pressure residual RMS": "СКЗ залишкового тиску",
  "Relative thrust residual": "Відносні коливання тяги",
  "Specific impulse": "Питомий імпульс",
  "Data coverage": "Покриття даними",
  "Impulse vs reference": "Імпульс відносно базового",
  "Difference RMSE": "СКЗ різниці",
  "Mean difference": "Середня різниця",
  "{count} samples · {rate} Hz · {start}–{end} s":
    "Відліків: {count} · {rate} Гц · {start}–{end} с",
  "Show {name}": "Показати {name}",
  "Noise interval: {start}–{end} s": "Інтервал шуму: {start}–{end} с",
  "Select ignition for {name} on the chart.":
    "Виберіть на графіку початок горіння для {name}.",
  "Select burnout for {name} on the chart.":
    "Виберіть на графіку кінець горіння для {name}.",
  "Choose a valid value inside the CSV time range.":
    "Укажіть коректне значення в часовому діапазоні CSV.",
  "Enter a positive propellant mass or leave it empty.":
    "Укажіть додатну масу палива або залиште поле порожнім.",
  "Add up to 12 CSV logs, each smaller than 20 MB (100 MB total).":
    "Додайте до 12 логів CSV, кожен менший за 20 МБ, разом — до 100 МБ.",
  "{name}: {details}": "{name}: {details}",
  "{count} profiles loaded. Review the detected burn events.":
    "Завантажено профілів: {count}. Перевірте визначені межі горіння.",
  "No profiles can be aligned. Set the missing burn events or choose original CSV time.":
    "Не вдалося сумістити профілі. Укажіть відсутні межі горіння або виберіть початковий час CSV.",
  "Time from ignition (s)": "Час від початку горіння (с)",
  "Time from burnout (s)": "Час від кінця горіння (с)",
  "Burn phase (%)": "Фаза горіння (%)",
  "CSV time (s)": "Час CSV (с)",
  "Select a profile to edit its A/B markers.":
    "Виберіть профіль, щоб змінити його маркери A/B.",
  "The reference profile is hidden. Show it to compare differences.":
    "Базовий профіль приховано. Покажіть його, щоб порівняти різницю.",
  "No common selected burn interval.":
    "Вибрані інтервали горіння не перекриваються.",
  "Choose a threshold between 0.1% and 99.9%, and a moving window from 1 to 10000 ms.":
    "Укажіть поріг від 0,1% до 99,9% і вікно усереднення від 1 до 10000 мс.",
  "No samples at this time.": "У цей момент немає відліків.",
  "Source time": "Час у джерелі",
  "Hide calculation notes": "Приховати методику розрахунку",
  "Processing CSV logs…": "Обробка логів CSV…",
};
