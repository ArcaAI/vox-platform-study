import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

/** Skeleton mirroring the voice-profiles screen: header, own-account note, wizard card, profile list, footer bar. */
export default function VoiceProfilesLoading() {
    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex flex-col gap-2">
                    <Skeleton className="h-8 w-56" />
                    <div className="flex items-center gap-2">
                        <Skeleton className="h-4 w-32" />
                        <Skeleton className="h-5 w-44 rounded-full" />
                    </div>
                </div>
                <Skeleton className="h-9 w-44" />
            </div>
            <Skeleton className="h-10 w-full" />
            <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
                <div className="flex flex-col gap-3 rounded-xl border p-4">
                    <Skeleton className="h-4 w-44" />
                    <div className="flex gap-2">
                        <Skeleton className="h-11 w-36" />
                        <Skeleton className="h-11 w-28" />
                    </div>
                    <Skeleton className="h-20 w-full" />
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-9 w-full" />
                    <div className="flex items-center justify-between gap-2">
                        <Skeleton className="h-4 w-40" />
                        <Skeleton className="h-9 w-40" />
                    </div>
                </div>
                <div className="flex flex-col gap-3 rounded-xl border p-4">
                    <Skeleton className="h-4 w-36" />
                    {Array.from({ length: 3 }, (_, index) => (
                        <div key={index} className="flex flex-col gap-2 rounded-md border p-3">
                            <div className="flex items-center gap-2">
                                <Skeleton className="h-4 w-40" />
                                <Skeleton className="h-5 w-16 rounded-full" />
                            </div>
                            <Skeleton className="h-3 w-2/3" />
                        </div>
                    ))}
                </div>
            </div>
            <Skeleton className="h-8 w-full" />
        </div>
    );
}
