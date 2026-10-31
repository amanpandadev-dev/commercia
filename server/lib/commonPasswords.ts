// Passwords people choose far too often, bundled with the program so the check needs no internet. Roots are short
// words (the check also strips digits and symbols from the ends and undoes "leet" letters, so "P@ssw0rd2024!" is "password");
// the longer entries are whole passwords that are common even at ten characters.
const ROOTS = `
password passwd pass admin administrator root user guest login welcome letmein changeme secret master qwerty qwertyuiop asdfgh asdfghjkl zxcvbn zxcvbnm
abc abcd abcde abcdef abcdefg abcdefgh iloveyou ilove love lover loveme lovely sunshine princess angel baby babygirl honey sweet monkey dragon football
baseball soccer cricket hockey tennis basketball superman batman spiderman ironman hello hello123 hellow test testing tester demo sample trustno1
shadow master1 michael jennifer jordan hunter buster thomas robert daniel andrew joshua matthew ashley nicole jessica charlie harley ranger
mustang freedom whatever cheese pepper cookie butterfly flower summer winter spring autumn monday friday sunday computer internet google facebook
whatsapp youtube instagram samsung iphone android windows linux apple orange banana yellow purple silver golden diamond killer ninja pirate
starwars matrix pokemon naruto
india indian bharat hindustan jaihind jaishreeram jaishriram ramram radhe radhekrishna krishna krishn ganesh ganesha shiva shivay mahadev hanuman
sai saibaba sairam omnamah omnamahshivay durga laxmi lakshmi vishnu ram sita radha gopal govind mohan rohan rahul amit sumit ankit ajay vijay sanjay
sunil anil ramesh suresh mukesh rakesh dinesh mahesh ritesh nitin sachin pooja priya neha ravi raju sharma verma gupta singh kumar yadav pandey mishra
agarwal jain shah patel mehta joshi
mumbai delhi lucknow kanpur varanasi jaipur kolkata chennai bangalore hyderabad pune ahmedabad bombay calcutta madras bihar punjab gujarat rajasthan
kirana kiranastore kiranashop store shop dukaan dukan dukandar market bazaar bazar general generalstore commercia sharma sharmakirana
company business office home house family mother father brother sister friend friends
`;
const WHOLE = `
password123 password1234 password12345 password123456 passw0rd123 p@ssword123 p@ssw0rd123 pa55word123 password@123 password#123 password!123
qwerty123 qwerty1234 qwerty12345 qwertyuiop qwertyuiop1 qwertyuiop123 qwerty@123 asdfghjkl asdfghjkl1 asdfghjkl123 zxcvbnm123 1qaz2wsx3edc
1q2w3e4r5t 1q2w3e4r5t6y 1qazxsw2 q1w2e3r4t5 q1w2e3r4t5y6 qazwsxedc 1234567890 12345678910 123456789a 12345678900 0123456789 1234512345 11111111111
1111111111 0000000000 9876543210 987654321 9876543210 1122334455 112233445566 123123123 1231231231 123123123123 123321123321 abcdefghij abcdefghijk
abcd123456 abc1234567 abc123456 abcdef1234 a1b2c3d4e5 aaaaaaaaaa bbbbbbbbbb 1234qwerty 1234567qwerty qwe123456 qwer123456 qwer1234 zaq12wsx
iloveyou12 iloveyou123 iloveyou1234 iloveyou2 ilovemyself ilovemymom ilovemyfamily iloveindia iloveindia123 iloveyou@123 loveyou123 loveyou1234
welcome123 welcome1234 welcome@123 welcome12345 welcome2020 welcome2021 welcome2022 welcome2023 welcome2024 welcome2025 welcome2026 welcome@1234
admin12345 admin123456 admin@12345 admin@123 admin1234 administrator1 admin@1234 admin#1234 adminadmin adminadmin1 adminadmin123 root123456 rootroot12
letmein123 letmein1234 letmein12345 changeme123 changeme1234 changeme12345 changethis1 changeit123 temp123456 temporary123 default123 default1234
test123456 test1234567 testing123 testing1234 testtest123 demo123456 demo1234567 demodemo12 sample1234 sample12345 guest12345 guest123456
shop123456 shop1234567 shopshop12 store123456 kirana123 kirana1234 kirana12345 kirana@123 kiranastore1 kiranashop1 kiranastore123 kiranashop123
commercia1 commercia12 commercia123 commercia1234 commercia@123 commercia2025 commercia2026 sharmakirana1 sharmakirana123 dukaan123 dukaan1234 dukan12345
india123 india1234 india12345 india@123 india@1234 india1947 india2020 india2024 india2025 india2026 bharat123 bharat1234 jaihind123 jaihind1234
jaishreeram1 jaishreeram123 jaishreeram@123 jaishriram123 radhekrishna1 radhekrishna123 radhekrishna@123 radhe@12345 krishna123 krishna1234 krishna@123
ganesh123 ganesh1234 ganesh@123 shiva12345 shiva@123 mahadev123 mahadev@123 hanuman123 hanuman@123 omnamahshivay omnamahshivay1 sairam123 sairam1234
sairam@123 jaimatadi123 jaimatadi1 jaimatadi@123 hariom123 hariom1234 ramram123 ramram1234 ramram@123 mumbai123 mumbai1234 delhi123 delhi1234 lucknow123
lucknow1234 kanpur123 kanpur1234 varanasi123 jaipur123 kolkata123 chennai123 bangalore123 hyderabad123 pune12345 ahmedabad123 punjab123 gujarat123
rahul12345 rahul123456 amit123456 sumit123456 ankit123456 ajay123456 vijay123456 sanjay12345 sunil123456 anil123456 ramesh12345 suresh12345 rakesh12345
mukesh12345 dinesh12345 mahesh12345 pooja12345 priya12345 neha123456 ravi123456 raju123456 sharma1234 sharma12345 sharma@123 verma12345 gupta12345
singh12345 kumar12345 yadav12345 pandey1234 mishra1234 agarwal123 patel12345
monkey1234 dragon1234 football123 football1234 baseball123 cricket123 cricket1234 cricket@123 iplcricket1 virat12345 viratkohli1 dhoni12345 sachin12345
sachin@1234 rohit12345 superman123 batman12345 spiderman12 sunshine123 sunshine12 princess123 princess12 butterfly1 butterfly12 trustno1234 mustang123
michael1234 jennifer123 jordan2345 liverpool1 manchester1 chelsea123 arsenal123 barcelona1 realmadrid1 mynameis12 myname12345 myself1234 mypassword1
mypassword12 mypassword123 mypass12345 mypass123456 mypassword@1 mypassw0rd1 passpass12 passpass123 pass123456 pass1234567 pass@12345 pass@123456
secret12345 secret123456 mysecret123 master12345 master123456 mastermaster google12345 google123456 facebook123 facebook1234 whatsapp123 instagram12
samsung1234 samsung12345 iphone12345 android1234 windows1234 windows12345 computer123 computer1234 internet123 internet1234 football@12 qazwsx12345
a123456789 a1234567890 b123456789 z123456789 q123456789 aa123456789 aa1234567890 abcd1234567 abcd@12345 abcd@1234 abc@123456 abc@12345 abc@1234
1a2b3c4d5e 1a2b3c4d5e6f 1a2s3d4f5g 1a2s3d4f5g6h 1z2x3c4v5b 123456789q 123456789qwe 123456qwerty 1234567qwe 12345qwert 12345abcde 12345abcdef 12345asdfg
123456abc 123456abcd 123456789abc 123abc123abc 123qweasdzxc 123qweasd 123qweasdzxc qweasdzxc123 qweasdzxc qweasdzxc1 asdqwe123 asdasd123 asdasdasd1
asdasdasdasd qweqweqwe1 qweqweqwe123 qwertyqwerty qwertyqwerty1 password1password hellohello1 hellohello hellohello123 testtesttest happy12345 happy123456
happybirthday happybirthday1 happy@12345 godisgood god12345 godislove god1234567 jesus12345 jesuschrist1 blessed123 blessed1234 forever123 forever1234
iamthebest iamthebest1 iamawesome1 superstar1 superstar12 rockstar12 rockstar123 sweetheart1 sweetheart12 chocolate1 chocolate12 chocolate123
`;

const words = (s: string) => s.split(/\s+/).filter(Boolean);
export const COMMON_ROOTS = new Set(words(ROOTS));
export const COMMON_WHOLE = new Set(words(WHOLE));
