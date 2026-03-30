export function getPhoneNumberType(number: string): 'Mobile' | 'Home' | 'Other' {
  if (number.startsWith('03') || number.startsWith('05') || number.startsWith('07') || number.startsWith('08') || number.startsWith('09')) {
    return 'Mobile';
  } else if (number.startsWith('02')) {
    return 'Home';
  }
  return 'Other';
}
