// The strip a view-only session sees (an invited address the owner set to
// צפייה בלבד): what it means, and a way back to the person's own account.
import { Eye } from 'lucide-react';

export function ReadOnlyBanner({ readOnly, accounts, onHome }) {
  if (!readOnly) return null;
  const home = (accounts || []).find((a) => a.is_home);
  return (
    <div className="bg-[#1E2C93] text-white text-sm px-6 py-2 text-center font-medium flex items-center justify-center gap-3 flex-wrap">
      <span className="inline-flex items-center gap-1.5"><Eye size={15} />צפייה בלבד — בחשבון הזה אי אפשר לשנות או להפעיל דבר.</span>
      {home && <button className="underline cursor-pointer" onClick={() => onHome(home.id)}>חזרה לחשבון שלי</button>}
    </div>
  );
}
