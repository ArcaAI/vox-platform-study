import {
    Card,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@arcaai/ui/card';
import { Button } from '@arcaai/ui/button';
import { Link } from '@tanstack/react-router';

export interface CtaProps {
    title: string;
    description: string;
    buttonLabel: string;
    href: string;
}

export function CtaCard({ title, description, buttonLabel, href }: CtaProps) {
    return (
        <Card className="mt-6">
            <CardHeader>
                <CardTitle className="text-sm">{title}</CardTitle>
                <CardDescription className="text-xs">{description}</CardDescription>
                <Link to={href}>
                    <Button variant="outline" size="sm" className="mt-2 w-full">
                        {buttonLabel}
                    </Button>
                </Link>
            </CardHeader>
        </Card>
    );
}
